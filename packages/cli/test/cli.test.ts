import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { KEYS, startStubPayee, type StubPayee, type StubPayeeOptions } from '../../wallet/test/stub-payee.js';
import { run } from '../src/cli.js';

const execFileAsync = promisify(execFile);
const CLI_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Any well-formed address will do: nothing in these tests touches a chain.
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const payeeAddress = privateKeyToAccount(KEYS.payee).address;
const facilitatorAddress = privateKeyToAccount(KEYS.facilitator).address;

function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    AGENTPAY_HOME: home,
    AGENTPAY_KEY: KEYS.payer,
    AGENTPAY_RPC: 'http://127.0.0.1:1',
    AGENTPAY_TOKEN: TOKEN,
    AGENTPAY_TOKEN_NAME: MOCK_USDC_DOMAIN.name,
    AGENTPAY_TOKEN_VERSION: MOCK_USDC_DOMAIN.version,
    AGENTPAY_NETWORK: 'eip155:31337',
  };
}

function stubOptions(over: Partial<StubPayeeOptions> = {}): StubPayeeOptions {
  return {
    payTo: payeeAddress,
    token: TOKEN,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: 'eip155:31337',
    price: '$0.001',
    facilitatorAddress,
    ...over,
  };
}

type Out = Record<string, any>;

describe('agentpay CLI', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let payee: StubPayee;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-cli-'));
    env = baseEnv(home);
    payee = await startStubPayee(stubOptions());
  });

  afterAll(async () => {
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('prints usage with exit 2 when no command is given, and for unknown commands / bad flags', async () => {
    const none = await run([], env);
    expect(none.code).toBe(2);
    expect((none.output as Out).usage).toContain('usage: agentpay');
    const unknown = await run(['frobnicate'], env);
    expect(unknown.code).toBe(2);
    expect((unknown.output as Out).error).toBe('config');
    const badFlag = await run(['mandate-list', '--nope'], env);
    expect(badFlag.code).toBe(2);
    expect((badFlag.output as Out).error).toBe('usage');
  });

  it('refuses to run without wallet configuration (exit 2, names the missing fields)', async () => {
    // DEPLOYMENT names a record that does not exist, so the localhost fallback is not consulted.
    const r = await run(['mandate-list'], { PATH: env.PATH, AGENTPAY_HOME: home, AGENTPAY_KEY: KEYS.payer, DEPLOYMENT: 'does-not-exist' });
    expect(r.code).toBe(2);
    expect((r.output as Out).message).toMatch(/missing configuration: token/);
    // a token without its domain is not enough: the payer would sign under the wrong domain
    const noDomain = await run(['mandate-list'], { ...env, AGENTPAY_TOKEN_NAME: undefined, AGENTPAY_TOKEN_VERSION: undefined, DEPLOYMENT: 'does-not-exist' });
    expect(noDomain.code).toBe(2);
    expect((noDomain.output as Out).message).toMatch(/token domain/);
  });

  it('address prints where to send USDC; balance and reconcile need an RPC', async () => {
    const a = await run(['address'], env);
    expect(a.code).toBe(0);
    expect((a.output as Out).address).toBe(privateKeyToAccount(KEYS.payer).address);
    expect((a.output as Out).tokenDomain).toEqual(MOCK_USDC_DOMAIN);
    // networks with a known public RPC get it by default; one without needs --rpc for the chain commands
    const noRpc = { ...env, AGENTPAY_RPC: undefined, AGENTPAY_NETWORK: 'eip155:5' };
    expect((await run(['balance'], noRpc)).code).toBe(2);
    expect((await run(['reconcile'], noRpc)).code).toBe(2);
    expect((await run(['address'], noRpc)).code).toBe(0); // signing-only commands work without one
  });

  it('mandate-create / list / status / disable', async () => {
    const created = await run(
      ['mandate-create', '--purpose', 'quotes for the report', '--limit', '$0.005', '--hosts', '127.0.0.1', '--valid-for', '3600'],
      env,
    );
    expect(created.code).toBe(0);
    const m = (created.output as Out).mandate;
    expect(m.status).toBe('signed');
    expect(m.limitAmount).toBe('5000');
    expect(m.remainingAmount).toBe('5000');
    expect(m.signature).toMatch(/^0x/);

    const list = await run(['mandate-list'], env);
    expect(list.code).toBe(0);
    expect((list.output as Out).count).toBe(1);

    const status = await run(['mandate-status', m.id], env);
    expect(status.code).toBe(0);
    expect((status.output as Out).payments).toBe(0);

    const disabled = await run(['mandate-disable', m.id], env);
    expect((disabled.output as Out).mandate.isEnabled).toBe(false);
    const enabled = await run(['mandate-enable', m.id], env);
    expect((enabled.output as Out).mandate.isEnabled).toBe(true);

    const missingFlags = await run(['mandate-create', '--limit', '1'], env);
    expect(missingFlags.code).toBe(2);
  });

  it('mandate-request creates a draft the human approves with mandate-approve', async () => {
    const draft = await run(['mandate-request', '--purpose', 'more quotes', '--limit', '1', '--hosts', '127.0.0.1'], env);
    expect(draft.code).toBe(0);
    const out = draft.output as Out;
    expect(out.mandate.status).toBe('draft');
    expect(out.next).toContain(`agentpay mandate-approve ${out.mandate.id}`);

    const approved = await run(['mandate-approve', out.mandate.id], env);
    expect(approved.code).toBe(0);
    expect((approved.output as Out).mandate.status).toBe('signed');
    // Leave only the first (small) mandate enabled so the budget tests below are deterministic.
    await run(['mandate-disable', out.mandate.id], env);
  });

  it('offer shows the 402 terms without paying', async () => {
    const r = await run(['offer', `${payee.url}/predict`], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.status).toBe(402);
    expect(out.offer[0].scheme).toBe('exact');
    expect(out.offer[0].amount).toBe('1000');
    expect(out.offer[0].extra).toMatchObject(MOCK_USDC_DOMAIN);
    expect(out.resource.url).toBe(`${payee.url}/predict`);
    expect(out.payment_model_context.reason).toBe('payment_required');
    expect(payee.served).toBe(0);
  });

  it('pay pays through the wallet and reports the settlement; ledger and report reflect it', async () => {
    const r = await run(['pay', `${payee.url}/predict`], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.status).toBe(200);
    expect(out.payment.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.payment.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.payment.payer).toBe(privateKeyToAccount(KEYS.payer).address);
    expect(out.payment.amount).toBe('1000');
    expect(out.payment.ledgerStatus).toBe('settled');
    expect(payee.served).toBe(1);

    const ledger = await run(['ledger'], env);
    expect((ledger.output as Out).count).toBe(1);
    const rejectedOnly = await run(['ledger', '--status', 'rejected'], env);
    expect((rejectedOnly.output as Out).count).toBe(0);

    const report = await run(['report'], env);
    expect((report.output as Out).report.totals.spent).toBe('1000');
    expect((report.output as Out).report.totals.settled).toBe(1);
  });

  it('pay is refused before signing once the budget is exhausted (exit 1 + payment_model_context)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await run(['pay', `${payee.url}/predict`], env);
      expect(r.code, `call ${i + 2}`).toBe(0);
    }
    const servedBefore = payee.served;
    const denied = await run(['pay', `${payee.url}/predict`], env);
    expect(denied.code).toBe(1);
    const out = denied.output as Out;
    expect(out.ok).toBe(false);
    expect(out.error).toBe('mandate_insufficient_budget');
    expect(out.payment_model_context.remediation.length).toBeGreaterThan(0);
    expect(payee.served).toBe(servedBefore);
  });

  it('pay surfaces a facilitator refusal as exit 1 with the reason and its hint', async () => {
    const rejecting = await startStubPayee(stubOptions({ price: '$0.0001' }));
    rejecting.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    try {
      // A fresh mandate with budget for this (cheaper) resource.
      const created = await run(['mandate-create', '--purpose', 'rejected', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const r = await run(['pay', `${rejecting.url}/predict`, '--mandate', (created.output as Out).mandate.id], env);
      expect(r.code).toBe(1);
      const out = r.output as Out;
      expect(out.status).toBe(402);
      expect(out.error).toBe('invalid_exact_evm_insufficient_balance');
      expect(out.payment_model_context.commands).toContain('agentpay address');
    } finally {
      await rejecting.close();
    }
  });

  it('a 2xx without a settlement report is paid: false with the reconcile-first hint', async () => {
    const raw = await startStubPayee(stubOptions({ price: '$0.0001', rawMode: 'no-response-header' }));
    try {
      const created = await run(['mandate-create', '--purpose', 'raw', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const r = await run(['pay', `${raw.url}/raw`, '--mandate', (created.output as Out).mandate.id], env);
      expect(r.code).toBe(0);
      const out = r.output as Out;
      expect(out.paid).toBe(false);
      expect(out.payment.ledgerStatus).toBe('unknown');
      expect(out.payment.payment_model_context.commands).toContain('agentpay reconcile');
    } finally {
      await raw.close();
    }
  });

  it('runs as a process: one JSON document on stdout and the documented exit codes', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli.ts', 'mandate-list'], { cwd: CLI_DIR, env });
    const parsed = JSON.parse(stdout) as Out;
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBeGreaterThanOrEqual(2);

    await expect(execFileAsync('npx', ['tsx', 'src/cli.ts'], { cwd: CLI_DIR, env })).rejects.toMatchObject({ code: 2 });
  });

  it('reports a counter rebuild on stderr and keeps stdout to the one JSON document', async () => {
    // A mandates.json whose counters drifted from the ledger (a crash between the two
    // writes) is healed on load; the operator sees the delta without stdout changing shape.
    const created = await run(['mandate-create', '--purpose', 'drift', '--limit', '1', '--hosts', '127.0.0.1'], env);
    const id = (created.output as Out).mandate.id as string;
    const mandatesPath = join(home, 'mandates.json');
    const file = JSON.parse(readFileSync(mandatesPath, 'utf8')) as { mandates: Array<{ id: string; spentAmount: string }> };
    const drifted = file.mandates.find((m) => m.id === id)!;
    drifted.spentAmount = String(BigInt(drifted.spentAmount) + 1n);
    writeFileSync(mandatesPath, JSON.stringify(file), 'utf8');

    const rebuildLines = (stderr: string) => stderr.split('\n').filter((l) => l.includes('counters rebuilt'));
    const first = await execFileAsync('npx', ['tsx', 'src/cli.ts', 'mandate-list'], { cwd: CLI_DIR, env });
    expect(rebuildLines(first.stderr)).toEqual([expect.stringContaining(`mandate ${id}: counters rebuilt from the ledger`)]);
    expect((JSON.parse(first.stdout) as Out).ok).toBe(true);

    // The heal was saved, so the next run has nothing to report (other stderr
    // noise, e.g. a Node deprecation warning from a dependency, is not ours to assert on).
    const second = await execFileAsync('npx', ['tsx', 'src/cli.ts', 'mandate-list'], { cwd: CLI_DIR, env });
    expect(rebuildLines(second.stderr)).toEqual([]);
    expect((JSON.parse(second.stdout) as Out).ok).toBe(true);
  });
});
