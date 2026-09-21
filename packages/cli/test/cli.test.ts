import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { LOCK_FILE } from '@agentpay/wallet';
import { KEYS, startStubPayee, type StubPayee, type StubPayeeOptions } from '../../wallet/test/stub-payee.js';
import { run } from '../src/cli.js';
import { startStubBazaar } from './stub-bazaar.js';
import { MAX_SAVE_BYTES, PREVIEW_BYTES } from '../src/save.js';

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

  it('discover queries the catalogue for this wallet network and works on a locked home (it is read-only)', async () => {
    // A localhost wallet (eip155:31337, the mock USDC) can pay none of the fixture rows: matched, but nothing payable.
    const bazaar = await startStubBazaar();
    const requests = payee.requests;
    try {
      const r = await run(['discover', 'market snapshot', '--bazaar', bazaar.url], env);
      expect(r.code).toBe(0);
      expect(r.output).toMatchObject({ ok: true, query: 'market snapshot', network: 'eip155:31337', bazaar: bazaar.url, matched: 5, payable: 0, resources: [] });
      expect(bazaar.calls[0].params).toMatchObject({ query: 'market snapshot', network: 'eip155:31337', type: 'http' });
      expect((r.output as Out).usage).toBeUndefined();
      expect(payee.requests).toBe(requests);
      // discover is not MUTATING: a running wallet's lock does not refuse it
      writeFileSync(join(home, LOCK_FILE), String(process.pid));
      try {
        expect((await run(['discover', 'x', '--bazaar', bazaar.url], env)).code).toBe(0);
        expect((await run(['pay', `${payee.url}/predict`], env)).output).toMatchObject({ error: 'locked' });
      } finally {
        rmSync(join(home, LOCK_FILE), { force: true });
      }
    } finally {
      await bazaar.close();
    }
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

/**
 * The agent surface: sub-budgets, payment attribution, callers and the lock.
 * A fresh home so the budgets stay deterministic: a parent of $0.004 pays
 * four $0.001 calls, and every assertion below counts them.
 */
describe('agentpay CLI: delegation, attribution, callers, lock', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let payee: StubPayee;
  let parentId: string;
  let childId: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-cli-agent-'));
    env = baseEnv(home);
    payee = await startStubPayee(stubOptions());
    // Two days of validity, so the 24 h delegation cap (not the parent's end) is the bound the test hits.
    const parent = await run(['mandate-create', '--purpose', 'parent budget', '--limit', '$0.004', '--hosts', '127.0.0.1', '--valid-for', '172800'], env);
    expect(parent.code).toBe(0);
    parentId = (parent.output as Out).mandate.id;
  });

  afterAll(async () => {
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('mandate-delegate refuses a child outside the parent (exit 1, the bound in the message)', async () => {
    const base = ['mandate-delegate', '--parent', parentId, '--holder', 'children:sess-1'];
    const overLimit = await run([...base, '--limit', '$0.005'], env);
    expect(overLimit.code).toBe(1);
    expect((overLimit.output as Out).message).toMatch(/limitAmount 5000 exceeds the parent's effective remaining budget 4000/);

    const tooLong = await run([...base, '--limit', '$0.001', '--valid-for', '90000'], env);
    expect(tooLong.code).toBe(1);
    expect((tooLong.output as Out).message).toMatch(/validForSeconds 90000 exceeds 86400/);

    const outsideHosts = await run([...base, '--limit', '$0.001', '--hosts', 'example.com'], env);
    expect(outsideHosts.code).toBe(1);
    expect((outsideHosts.output as Out).message).toMatch(/"example.com" is not within the parent's allowlist \[127\.0\.0\.1\]/);

    // a holder outside the vocabulary is a usage error, before anything is signed
    const badHolder = await run(['mandate-delegate', '--parent', parentId, '--holder', 'nobody', '--limit', '$0.001'], env);
    expect(badHolder.code).toBe(2);
    expect((badHolder.output as Out).error).toBe('usage');
    expect((await run(['mandate-list'], env)).output).toMatchObject({ count: 1 });
  });

  it('mandate-delegate creates a signed child; list and status show parentId/holder and the effective remaining', async () => {
    const r = await run(['mandate-delegate', '--parent', parentId, '--holder', 'children:sess-1', '--limit', '$0.003'], env);
    expect(r.code).toBe(0);
    const child = (r.output as Out).mandate;
    childId = child.id;
    expect(child.status).toBe('signed');
    expect(child.signature).toMatch(/^0x/);
    expect(child.parentId).toBe(parentId);
    expect(child.holder).toBe('children:sess-1');
    expect(child.hostAllowlist).toEqual(['127.0.0.1']); // inherited
    expect(child.naturalLanguage).toBe('parent budget (delegated)');
    expect(child.limitAmount).toBe('3000');
    expect(child.remainingAmount).toBe('3000');

    const list = await run(['mandate-list'], env);
    expect((list.output as Out).count).toBe(2);
    const listed = (list.output as Out).mandates.find((m: Out) => m.id === childId);
    expect(listed).toMatchObject({ parentId, holder: 'children:sess-1', remainingAmount: '3000' });
    const root = (list.output as Out).mandates.find((m: Out) => m.id === parentId);
    expect(root.parentId).toBeUndefined();
    expect(root.holder).toBeUndefined();

    const status = await run(['mandate-status', childId], env);
    expect(status.code).toBe(0);
    expect((status.output as Out).mandate).toMatchObject({ parentId, holder: 'children:sess-1' });
    expect((status.output as Out).payments).toBe(0);
  });

  it('pay --context k=v lands on the ledger row and in the report by channel / session', async () => {
    const r = await run(['pay', `${payee.url}/predict`, '--context', 'channel=slack', '--context', 'session=sess-1', '--context', 'label=quote 1'], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.payment.intentMandateId).toBe(parentId); // the principal pays from the unheld root
    expect(out.payment.context).toEqual({ channel: 'slack', session: 'sess-1', label: 'quote 1' });

    const ledger = await run(['ledger'], env);
    expect((ledger.output as Out).entries[0].context).toEqual({ channel: 'slack', session: 'sess-1', label: 'quote 1' });

    const report = (await run(['report'], env)).output as Out;
    expect(report.report.byChannel).toEqual({ slack: '1000' });
    expect(report.report.bySession).toEqual({ 'sess-1': '1000' });
    expect(report.report.byChannelUsd.slack).toBe('$0.001000');

    // malformed pairs and unknown keys are usage errors, before any request
    const served = payee.served;
    const noEq = await run(['pay', `${payee.url}/predict`, '--context', 'channel'], env);
    expect(noEq.code).toBe(2);
    expect((noEq.output as Out).message).toMatch(/--context expects k=v/);
    const unknownKey = await run(['pay', `${payee.url}/predict`, '--context', 'colour=blue'], env);
    expect(unknownKey.code).toBe(2);
    expect((unknownKey.output as Out).message).toMatch(/context\.colour is not a known field/);
    expect(payee.served).toBe(served);
  });

  it('AGENTPAY_CONTEXT supplies defaults; a --context flag overrides the same key', async () => {
    const withEnv = { ...env, AGENTPAY_CONTEXT: 'channel=env-channel, label=from env' };
    const r = await run(['pay', `${payee.url}/predict`, '--context', 'channel=flag-channel'], withEnv);
    expect(r.code).toBe(0);
    expect((r.output as Out).payment.context).toEqual({ channel: 'flag-channel', label: 'from env' });
    const report = (await run(['report'], env)).output as Out;
    expect(report.report.byChannel).toEqual({ slack: '1000', 'flag-channel': '1000' });
    expect(report.report.byChannel['env-channel']).toBeUndefined();

    // The parent has now spent 2 of its 4 calls: the child's own counter is untouched
    // but its EFFECTIVE remaining is the parent's 2000, which is what list/status print.
    const status = (await run(['mandate-status', childId], env)).output as Out;
    expect(status.mandate.spentAmount).toBe('0');
    expect(status.mandate.limitAmount).toBe('3000');
    expect(status.mandate.remainingAmount).toBe('2000');
  });

  it('--caller child:<id>@<parent> pays from a children:<parent> mandate; the principal cannot', async () => {
    const r = await run(['pay', `${payee.url}/predict`, '--caller', 'child:kid-1@sess-1'], env);
    expect(r.code).toBe(0);
    expect((r.output as Out).paid).toBe(true);
    expect((r.output as Out).payment.intentMandateId).toBe(childId);
    // the child's spend is accounted on the whole chain: its own row and the parent
    const status = (await run(['mandate-status', childId], env)).output as Out;
    expect(status.payments).toBe(1);
    expect(status.mandate.spentAmount).toBe('1000');
    expect(status.mandate.remainingAmount).toBe('1000'); // min(own 2000, parent 1000)
    expect((await run(['mandate-status', parentId], env)).output).toMatchObject({ mandate: { spentAmount: '3000', remainingAmount: '1000' } });

    const served = payee.served;
    // an explicit --mandate the principal does not hold
    const mismatch = await run(['pay', `${payee.url}/predict`, '--mandate', childId], env);
    expect(mismatch.code).toBe(1);
    expect(mismatch.output).toMatchObject({ ok: false, error: 'holder_mismatch', detail: { mandateId: childId, holder: 'children:sess-1', caller: 'principal' } });
    expect((mismatch.output as Out).payment_model_context.reason).toBe('holder_mismatch');
    // a caller nothing was delegated to
    const unheld = await run(['pay', `${payee.url}/predict`, '--caller', 'session:stranger'], env);
    expect(unheld.code).toBe(1);
    expect(unheld.output).toMatchObject({ ok: false, error: 'no_held_mandate', detail: { caller: 'session stranger' } });
    expect((unheld.output as Out).payment_model_context.remediation.length).toBeGreaterThan(0);
    // a child of another session sees neither budget
    const otherChild = await run(['pay', `${payee.url}/predict`, '--caller', 'child:kid-9@sess-2'], env);
    expect(otherChild.code).toBe(1);
    expect((otherChild.output as Out).error).toBe('no_held_mandate');
    // and the grammar is enforced before anything is sent
    const badCaller = await run(['pay', `${payee.url}/predict`, '--caller', 'child:kid-1'], env);
    expect(badCaller.code).toBe(2);
    expect((badCaller.output as Out).message).toMatch(/child:<id>@<parentSession>/);
    expect(payee.served).toBe(served);
  });

  it('a locked home refuses pay and mandate-* with error "locked" naming the pid; reads still answer', async () => {
    const lockPath = join(home, LOCK_FILE);
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8'); // our own pid: alive for as long as the test runs
    try {
      const served = payee.served;
      const paid = await run(['pay', `${payee.url}/predict`], env);
      expect(paid.code).toBe(2);
      expect(paid.output).toMatchObject({ ok: false, error: 'locked', pid: process.pid, home });
      expect((paid.output as Out).message).toContain(`locked by pid ${process.pid}`);
      expect(payee.served).toBe(served);

      const created = await run(['mandate-create', '--purpose', 'while locked', '--limit', '1', '--hosts', '127.0.0.1'], env);
      expect(created.code).toBe(2);
      expect((created.output as Out).error).toBe('locked');
      expect((await run(['mandate-delegate', '--parent', parentId, '--holder', 'bot:b', '--limit', '$0.001'], env)).output).toMatchObject({ error: 'locked' });

      const list = await run(['mandate-list'], env);
      expect(list.code).toBe(0);
      expect((list.output as Out).count).toBe(2);
      expect((await run(['mandate-status', childId], env)).code).toBe(0);
      expect((await run(['report'], env)).code).toBe(0);
      expect(existsSync(lockPath)).toBe(true); // a live lock is never removed by a reader
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it('pay --save writes the body under the current directory with its sha256 and prints a preview, not the body', async () => {
    const big = await startStubPayee(stubOptions({ price: '$0.0001', bigBytes: 100_000 }));
    const cwd = process.cwd();
    const saveDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentpay-cli-save-'))); // cwd is a real path (macOS /var -> /private/var)
    process.chdir(saveDir);
    try {
      const created = await run(['mandate-create', '--purpose', 'bars', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const id = (created.output as Out).mandate.id as string;
      const r = await run(['pay', `${big.url}/big`, '--mandate', id, '--save', 'massive/AAPL/2016.json'], env);
      expect(r.code).toBe(0);
      const out = r.output as Out;
      expect(out.paid).toBe(true);
      expect(out.body).toBeUndefined();
      const path = join(saveDir, 'massive', 'AAPL', '2016.json');
      // saved.path is the relative path as given (normalised), not the resolved absolute one.
      expect(out.saved.path).toBe('massive/AAPL/2016.json');
      const file = readFileSync(path);
      expect(file.byteLength).toBe(100_000);
      expect(out.saved).toEqual({ path: 'massive/AAPL/2016.json', bytes: 100_000, sha256: createHash('sha256').update(file).digest('hex'), content_type: 'application/json; charset=utf-8' });
      expect(out.preview_truncated).toBe(true);
      expect(Buffer.byteLength(out.preview, 'utf8')).toBeLessThanOrEqual(PREVIEW_BYTES);
      expect(readdirSync(join(saveDir, 'massive', 'AAPL'))).toEqual(['2016.json']);
      // --save without a label: the CLI keeps the context as given (the tool table is where the file name becomes the label).
      expect(out.payment.context).toBeUndefined();

      // Existing file: refused before the request unless --overwrite; every unsafe path likewise.
      const served = big.served;
      const requests = big.requests;
      const exists = await run(['pay', `${big.url}/big`, '--mandate', id, '--save', 'massive/AAPL/2016.json'], env);
      expect(exists.code).toBe(2);
      expect((exists.output as Out).message).toMatch(/exists; pass overwrite/);
      for (const bad of ['../x.json', '/tmp/x.json', 'C:\\x.json', '', 'a/../../x.json']) {
        const r2 = await run(['pay', `${big.url}/big`, '--mandate', id, '--save', bad], env);
        expect(r2.code, bad).toBe(2);
        expect((r2.output as Out).error).toBe('config');
      }
      expect(big.requests).toBe(requests);
      expect(big.served).toBe(served);
      writeFileSync(path, 'stale');
      const over = await run(['pay', `${big.url}/big`, '--mandate', id, '--save', 'massive/AAPL/2016.json', '--overwrite'], env);
      expect(over.code).toBe(0);
      expect(readFileSync(path).byteLength).toBe(100_000);
      // A non-2xx is reported exactly as without --save, and nothing is written.
      const failing = await startStubPayee(stubOptions({ price: '$0.0001', bigBytes: 100_000, handlerStatus: 500 }));
      try {
        const bad = await run(['pay', `${failing.url}/big`, '--mandate', id, '--save', 'failed.json'], env);
        expect(bad.code).toBe(1);
        expect((bad.output as Out).status).toBe(500);
        expect((bad.output as Out).saved).toBeUndefined();
        expect(existsSync(join(saveDir, 'failed.json'))).toBe(false);
      } finally {
        await failing.close();
      }
    } finally {
      process.chdir(cwd);
      await big.close();
      rmSync(saveDir, { recursive: true, force: true });
    }
  });

  it('pay --save over 32 MiB is paid but not written: saved.error body_too_large, no throw', async () => {
    const huge = await startStubPayee(stubOptions({ price: '$0.0001', bigBytes: MAX_SAVE_BYTES + 1 }));
    const cwd = process.cwd();
    const saveDir = mkdtempSync(join(tmpdir(), 'agentpay-cli-huge-'));
    process.chdir(saveDir);
    try {
      const created = await run(['mandate-create', '--purpose', 'huge', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const r = await run(['pay', `${huge.url}/big`, '--mandate', (created.output as Out).mandate.id, '--save', 'huge.json'], env);
      expect(r.code).toBe(0);
      const out = r.output as Out;
      expect(out.paid).toBe(true);
      expect(out.saved.error).toBe('body_too_large');
      expect(out.saved.path).toBe('huge.json');
      expect(out.saved.bytes).toBe(MAX_SAVE_BYTES + 1);
      expect(out.saved.limit).toBe(MAX_SAVE_BYTES);
      expect(out.saved.sha256).toBeUndefined();
      expect(out.body).toBeUndefined();
      expect(out.preview_truncated).toBe(true);
      expect(readdirSync(saveDir)).toEqual([]);
    } finally {
      process.chdir(cwd);
      await huge.close();
      rmSync(saveDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs --save as a process: the file lands relative to the process cwd; ../ exits 2 and pays nothing', async () => {
    const big = await startStubPayee(stubOptions({ price: '$0.0001', bigBytes: 20_000 }));
    const saveDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentpay-cli-proc-')));
    try {
      const created = await run(['mandate-create', '--purpose', 'proc', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const id = (created.output as Out).mandate.id as string;
      const cliPath = join(CLI_DIR, 'src', 'cli.ts');
      const { stdout } = await execFileAsync('npx', ['tsx', cliPath, 'pay', `${big.url}/big`, '--mandate', id, '--save', 'out/bars.json'], { cwd: saveDir, env });
      const parsed = JSON.parse(stdout) as Out;
      expect(parsed.ok).toBe(true);
      expect(parsed.saved.path).toBe('out/bars.json');
      expect(stdout).not.toContain(saveDir);
      expect(parsed.saved.bytes).toBe(20_000);
      expect(parsed.body).toBeUndefined();
      const file = readFileSync(join(saveDir, 'out', 'bars.json'));
      expect(createHash('sha256').update(file).digest('hex')).toBe(parsed.saved.sha256);

      const requests = big.requests;
      await expect(execFileAsync('npx', ['tsx', cliPath, 'pay', `${big.url}/big`, '--mandate', id, '--save', '../x.json'], { cwd: saveDir, env })).rejects.toMatchObject({ code: 2 });
      expect(big.requests).toBe(requests);
      expect(existsSync(join(tmpdir(), 'x.json'))).toBe(false);
    } finally {
      await big.close();
      rmSync(saveDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a stale lock (dead pid) is ignored and cleaned up', async () => {
    const lockPath = join(home, LOCK_FILE);
    // A process that has already exited: its pid is dead (reuse within the test is not a realistic race).
    const dead = spawnSync('true').pid;
    expect(dead).toBeGreaterThan(0);
    writeFileSync(lockPath, `${dead}\n`, 'utf8');
    const created = await run(['mandate-create', '--purpose', 'after a crash', '--limit', '1', '--hosts', '127.0.0.1'], env);
    expect(created.code).toBe(0);
    expect((created.output as Out).mandate.status).toBe('signed');
    expect(existsSync(lockPath)).toBe(false);
  });
});
