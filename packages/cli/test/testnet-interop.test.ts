import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { LOCK_FILE } from '@agentpay/wallet';
import { KEYS, startStubPayee, type StubPayee } from '../../wallet/test/stub-payee.js';
import { CommandContext } from '../src/context.js';
import { ok } from '../src/output.js';
import {
  DISCOVER_QUERY,
  MANDATE,
  TESTNET,
  bodyBytes,
  findOrCreateMandate,
  formatSummary,
  guard,
  reportPath,
  runInterop,
  summarizeAccepts,
  timeoutOk,
  type InteropDeps,
} from '../scripts/testnet-interop.js';

// The script's guard is about the NETWORK the home resolves to, not the chain: the stub payee
// and facilitator speak eip155:84532 here and nothing touches an RPC (reconcile meets a closed port).
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const payeeAddress = privateKeyToAccount(KEYS.payee).address;
const facilitatorAddress = privateKeyToAccount(KEYS.facilitator).address;
const payerAddress = privateKeyToAccount(KEYS.payer).address;

function baseEnv(home: string, network = TESTNET): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    AGENTPAY_HOME: home,
    AGENTPAY_KEY: KEYS.payer,
    AGENTPAY_RPC: 'http://127.0.0.1:1',
    AGENTPAY_TOKEN: TOKEN,
    AGENTPAY_TOKEN_NAME: MOCK_USDC_DOMAIN.name,
    AGENTPAY_TOKEN_VERSION: MOCK_USDC_DOMAIN.version,
    AGENTPAY_NETWORK: network,
  };
}

describe('testnet interop script', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let payee: StubPayee;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-interop-'));
    env = baseEnv(home);
    payee = await startStubPayee({ payTo: payeeAddress, token: TOKEN, assetDomain: { ...MOCK_USDC_DOMAIN }, network: TESTNET, price: '$0.001', facilitatorAddress });
  });

  afterAll(async () => {
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  function deps(over: Partial<InteropDeps> = {}): InteropDeps {
    const config = guard(env);
    return {
      ctx: new CommandContext(config, globalThis.fetch, () => {}),
      config,
      targets: [{ name: 'stub-predict', url: `${payee.url}/predict` }],
      txFrom: async () => facilitatorAddress,
      concurrency: 3,
      log: () => {},
      ...over,
    };
  }

  it('guard: refuses any network but Base Sepolia and a locked home (exit-2 ConfigError), keeps the default RPC', () => {
    expect(() => guard(baseEnv(home, 'eip155:31337'))).toThrow(/testnet only/);
    expect(guard(env).network).toBe(TESTNET);
    // the RPC comes from resolveConfig's table when nothing sets it: the script never hard-codes one
    expect(guard({ ...env, AGENTPAY_RPC: undefined }).rpcUrl).toBe('https://sepolia.base.org');
    writeFileSync(join(home, LOCK_FILE), `${process.pid}\n`);
    try {
      expect(() => guard(env)).toThrow(/locked by pid/);
    } finally {
      rmSync(join(home, LOCK_FILE));
    }
  });

  it('summarizeAccepts / timeoutOk project an offer and judge it against the 300 s cap', () => {
    const rows = summarizeAccepts([
      { scheme: 'exact', network: TESTNET, asset: TOKEN, amount: '10000', payTo: payeeAddress, maxTimeoutSeconds: 300, extra: { name: 'USDC' }, description: 'x'.repeat(5000) },
      { scheme: 'exact', network: 'eip155:8453', asset: TOKEN, amount: '10000', payTo: payeeAddress, maxTimeoutSeconds: 900 },
      'garbage',
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ scheme: 'exact', network: TESTNET, asset: TOKEN, amount: '10000', amount_usd: '$0.010000', pay_to: payeeAddress, max_timeout_s: 300 });
    expect(rows[2].amount_usd).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('description');
    expect(timeoutOk(rows, TESTNET)).toBe(true); // the 900 s row is for another network
    expect(timeoutOk(rows, 'eip155:8453')).toBe(false);
    expect(timeoutOk(rows, 'eip155:1')).toBeNull();
    expect(summarizeAccepts(undefined)).toEqual([]);
  });

  it('bodyBytes: the saved size, the string size, or the re-serialised JSON size', () => {
    expect(bodyBytes({ saved: { bytes: 42 } })).toBe(42);
    expect(bodyBytes({ body: 'héllo' })).toBe(6);
    expect(bodyBytes({ body: { a: 1 } })).toBe(7);
    expect(bodyBytes({})).toBeNull();
  });

  it('runs end to end against a stub stranger: mandate created once, offer + pay + chain rows, 3 concurrent, reconcile counts recorded, discovery skipped', async () => {
    const report = await runInterop(deps());
    expect(report.version).toBe(1);
    expect(report.network).toBe(TESTNET);
    expect(report.payer).toBe(payerAddress);
    expect(report.discovery).toEqual({ skipped: true, reason: expect.stringMatching(/no discover command/) });

    expect(report.mandate.created).toBe(true);
    expect(report.mandate.hosts).toEqual([...MANDATE.hosts]);
    const t = report.targets[0];
    expect(t.method).toBe('GET');
    expect(t.offer.status).toBe(402);
    expect(t.offer.accepts[0].amount_usd).toBe('$0.001000');
    expect(t.offer.timeout_ok).toBe(true);
    expect(t.pay.status).toBe(200);
    expect(t.pay.ledger_status).toBe('settled');
    expect(t.pay.amount).toBe('1000');
    expect(t.pay.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(t.pay.body_bytes).toBeGreaterThan(0);
    expect(t.pay.settlement?.payer).toBe(payerAddress);
    expect(t.chain).toEqual({ tx_from: facilitatorAddress, settlement_payer: payerAddress, payer_is_wallet: true });

    expect(report.concurrent.n).toBe(3);
    expect(report.concurrent.results.filter((r) => r.ledger_status === 'settled')).toHaveLength(3);
    expect(report.reconcile.counts).toMatchObject({ settled: 0, stillPending: 4 }); // the closed RPC port verifies nothing: the four rows stay as they are, and the script records that rather than throwing
    expect(report.totals).toEqual({ paid: 4, refused: 0, spent_usd: '$0.004000' });
    expect(report.ledger).toEqual({ rows_added: 4, by_status: { settled: 4 }, settled_usd: '$0.004000', reserved_usd: '$0.000000' });
    expect(report.notes).toEqual([expect.stringMatching(/keeps 4 row\(s\) pending/)]);
    expect(payee.payments).toHaveLength(4);

    // a second run reuses the mandate the first one created
    const again = await runInterop(deps({ concurrency: 1 }));
    expect(again.mandate).toMatchObject({ id: report.mandate.id, created: false });

    const text = formatSummary(report);
    expect(text).toContain(`mandate:   ${report.mandate.id} (new)`);
    expect(text).toContain('concurrent x3: 3/3 settled');
    expect(text.split('\n').length).toBeLessThan(20);
  });

  it('findOrCreateMandate ignores a mandate that misses one of the hosts', async () => {
    const config = guard(env);
    const ctx = new CommandContext(config, globalThis.fetch, () => {});
    const wallet = ctx.wallet();
    const before = wallet.listMandates().length;
    await wallet.createIntentMandate({ naturalLanguage: 'only local', limitAmount: '100000', validForSeconds: 600, hostAllowlist: ['127.0.0.1'] }, { approve: true });
    const { mandate, created } = await findOrCreateMandate(wallet, ctx);
    expect(created).toBe(false); // the earlier run's mandate still covers all three
    expect(mandate.hostAllowlist).toEqual([...MANDATE.hosts]);
    for (const m of wallet.listMandates()) wallet.setEnabled(m.id, false);
    const fresh = await findOrCreateMandate(wallet, ctx);
    expect(fresh.created).toBe(true);
    expect(fresh.mandate.naturalLanguage).toBe(MANDATE.purpose);
    expect(fresh.mandate.perCallMax).toBe('10000');
    expect(fresh.mandate.validUntil - fresh.mandate.validFrom).toBe(MANDATE.validFor);
    expect(wallet.listMandates().length).toBe(before + 2);
  });

  it('records a refusal and a discovery result instead of throwing; saves the body when a saveRoot is given', async () => {
    const saveRoot = mkdtempSync(join(tmpdir(), 'agentpay-interop-save-'));
    try {
      const discover = async () => ok({ query: DISCOVER_QUERY, matched: 7, payable: 2, resources: Array.from({ length: 6 }, (_, i) => ({ resource: `https://r${i}` })) });
      const report = await runInterop(
        deps({
          targets: [
            { name: 'stub-predict', url: `${payee.url}/predict` },
            { name: 'no-such-host', url: 'http://127.0.0.1:1/x' },
          ],
          discover,
          saveRoot,
          concurrency: 1,
          txFrom: async () => {
            throw new Error('rpc down');
          },
        }),
      );
      expect(report.discovery).toMatchObject({ skipped: false, matched: 7, payable: 2 });
      expect((report.discovery as { top: unknown[] }).top).toHaveLength(5);
      const [good, bad] = report.targets;
      expect(good.pay.saved).toMatchObject({ path: 'stub-predict.body' }); // relative: the report never carries the save directory
      expect(existsSync(join(saveRoot, 'stub-predict.body'))).toBe(true);
      expect(good.pay.body_bytes).toBe(readFileSync(join(saveRoot, 'stub-predict.body')).byteLength);
      expect(good.chain).toMatchObject({ tx_from: null, error: 'rpc down', payer_is_wallet: true });
      expect(bad.offer.status).toBeNull();
      expect(bad.offer.error).toBeDefined();
      expect(bad.pay.ledger_status).toBeNull();
      expect(bad.pay.error).toBeDefined();
      expect(report.totals.refused).toBe(2); // the pay to the closed port and the concurrent one (last target)
      expect(report.ledger).toMatchObject({ rows_added: 1, by_status: { settled: 1 } }); // a dead host leaves no row
      expect(formatSummary(report)).toContain('error=');
    } finally {
      rmSync(saveRoot, { recursive: true, force: true });
    }
  });

  it('a payee that refuses after the signature reads as rejected with its amount reserved, from the row the wallet wrote', async () => {
    const refusing = await startStubPayee({ payTo: payeeAddress, token: TOKEN, assetDomain: { ...MOCK_USDC_DOMAIN }, network: TESTNET, price: '$0.002', facilitatorAddress, handlerStatus: 503 });
    try {
      const report = await runInterop(deps({ targets: [{ name: 'refusing', url: `${refusing.url}/predict` }], concurrency: 2 }));
      const t = report.targets[0];
      expect(t.pay).toMatchObject({ status: 503, ledger_status: 'rejected', amount: '2000', amount_usd: '$0.002000', tx: null });
      expect(t.pay.error).toMatchObject({ ok: false, status: 503 });
      expect(t.chain).toBeNull();
      // concurrent refusals to one URL are never matched to rows (a race would mis-attribute); the ledger section counts them anyway
      for (const r of report.concurrent.results) expect(r.ledger_status).toBeNull();
      expect(report.ledger).toEqual({ rows_added: 3, by_status: { rejected: 3 }, settled_usd: '$0.000000', reserved_usd: '$0.006000' });
      expect(report.totals).toEqual({ paid: 0, refused: 3, spent_usd: '$0.000000' });
      expect(report.notes).toEqual([expect.stringMatching(/pending/), expect.stringMatching(/refusing refused after the authorization was signed \(http 503\)/)]);
      expect(formatSummary(report)).toContain('note: refusing refused');
    } finally {
      await refusing.close();
    }
  });

  it('reportPath: INTEROP_OUT wins, else docs/interop/testnet-interop-<date>.json', () => {
    expect(reportPath({ INTEROP_OUT: '/tmp/x.json' }, new Date())).toBe('/tmp/x.json');
    expect(reportPath({}, new Date('2026-09-21T15:00:00Z'))).toMatch(/\/docs\/interop\/testnet-interop-2026-09-21\.json$/);
  });
});
