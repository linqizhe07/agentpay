import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS, startStubPayee, type StubPayee } from '../../wallet/test/stub-payee.js';
import { run } from '../src/cli.js';

const execFileAsync = promisify(execFile);
const CLI_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Any well-formed addresses will do: nothing in these tests touches a chain.
const WALLET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    AGENTPAY_HOME: home,
    AGENTPAY_KEY: KEYS.payer,
    AGENTPAY_RPC: 'http://127.0.0.1:1',
    AGENTPAY_WALLET: WALLET,
    AGENTPAY_TOKEN: TOKEN,
    AGENTPAY_NETWORK: 'eip155:31337',
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
    payee = await startStubPayee({
      payeeKey: KEYS.payee,
      spKey: KEYS.sp,
      wallet: WALLET,
      token: TOKEN,
      network: 'eip155:31337',
      price: '1000',
      settleWindowSeconds: 300,
    });
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
    expect((r.output as Out).message).toMatch(/missing configuration: wallet/);
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
    expect(out.offer[0].scheme).toBe('aep2');
    expect(out.offer[0].amount).toBe('1000');
    expect(payee.served).toBe(0);
  });

  it('pay pays through the wallet and reports the SP receipt; ledger and report reflect it', async () => {
    const r = await run(['pay', `${payee.url}/predict`], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.status).toBe(200);
    expect(out.payment.mandateDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.payment.spReceipt.sp.toLowerCase()).toBe(payee.spAddress.toLowerCase());
    expect(out.payment.amount).toBe('1000');
    expect(out.payment.ledgerStatus).toBe('enqueued');
    expect(payee.served).toBe(1);

    const ledger = await run(['ledger'], env);
    expect((ledger.output as Out).count).toBe(1);
    const enqueuedOnly = await run(['ledger', '--status', 'settled'], env);
    expect((enqueuedOnly.output as Out).count).toBe(0);

    const report = await run(['report'], env);
    expect((report.output as Out).report.totals.spent).toBe('1000');
    expect((report.output as Out).report.totals.enqueued).toBe(1);
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

  it('pay surfaces a payee rejection as exit 1 with the payee reason', async () => {
    const rejecting = await startStubPayee({
      payeeKey: KEYS.payee,
      spKey: KEYS.sp,
      wallet: WALLET,
      token: TOKEN,
      network: 'eip155:31337',
      price: '100',
      settleWindowSeconds: 300,
      mode: { reject: { status: 402, body: { error: 'settlement_unavailable: sp_not_authorized' } } },
    });
    try {
      // A fresh mandate with budget for this (cheaper) resource.
      const created = await run(['mandate-create', '--purpose', 'rejected', '--limit', '1', '--hosts', '127.0.0.1'], env);
      const r = await run(['pay', `${rejecting.url}/predict`, '--mandate', (created.output as Out).mandate.id], env);
      expect(r.code).toBe(1);
      const out = r.output as Out;
      expect(out.status).toBe(402);
      expect(out.error).toBe('settlement_unavailable: sp_not_authorized');
      expect(out.payment_model_context.reason).toBe('settlement_unavailable');
    } finally {
      await rejecting.close();
    }
  });

  it('runs as a process: one JSON document on stdout and the documented exit codes', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli.ts', 'mandate-list'], { cwd: CLI_DIR, env });
    const parsed = JSON.parse(stdout) as Out;
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBeGreaterThanOrEqual(2);

    await expect(execFileAsync('npx', ['tsx', 'src/cli.ts'], { cwd: CLI_DIR, env })).rejects.toMatchObject({ code: 2 });
  });
});
