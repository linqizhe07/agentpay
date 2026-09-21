import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { PRINCIPAL, type Caller } from '@agentpay/wallet';
import { KEYS, startStubPayee, type StubPayee, type StubPayeeOptions } from '../../wallet/test/stub-payee.js';
import { resolveConfig } from '../src/config.js';
import { CommandContext } from '../src/context.js';
import { WALLET_TOOLS, createWalletToolHandlers, type WalletToolHandler } from '../src/tools.js';
import { PREVIEW_BYTES } from '../src/save.js';

const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const payeeAddress = privateKeyToAccount(KEYS.payee).address;
const facilitatorAddress = privateKeyToAccount(KEYS.facilitator).address;

function stubOptions(over: Partial<StubPayeeOptions> = {}): StubPayeeOptions {
  return { payTo: payeeAddress, token: TOKEN, assetDomain: { ...MOCK_USDC_DOMAIN }, network: 'eip155:31337', price: '$0.001', facilitatorAddress, ...over };
}

type Out = Record<string, any>;
const PARENT: Caller = { kind: 'session', id: 'parent-1' };
const CHILD: Caller = { kind: 'child', id: 'kid-1', parentSession: 'parent-1' };

describe('wallet tool table', () => {
  let home: string;
  let ctx: CommandContext;
  let call: WalletToolHandler;
  let payee: StubPayee;
  let rootId: string;
  let childId: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-tools-'));
    payee = await startStubPayee(stubOptions());
    const config = resolveConfig({}, {
      AGENTPAY_HOME: home,
      AGENTPAY_KEY: KEYS.payer,
      AGENTPAY_RPC: 'http://127.0.0.1:1', // nothing listens: balance must degrade to {unavailable}, never throw
      AGENTPAY_TOKEN: TOKEN,
      AGENTPAY_TOKEN_NAME: MOCK_USDC_DOMAIN.name,
      AGENTPAY_TOKEN_VERSION: MOCK_USDC_DOMAIN.version,
      AGENTPAY_NETWORK: 'eip155:31337',
    });
    // A host process: one long-lived wallet, host pre-flight on, nothing on stderr.
    ctx = new CommandContext(config, globalThis.fetch, () => {}, { requireMandateHost: true });
    call = createWalletToolHandlers(ctx);
  });

  afterAll(async () => {
    ctx.dispose();
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('describes nine tools with closed JSON schemas and USD-string amounts', () => {
    expect(WALLET_TOOLS.map((t) => t.name)).toEqual([
      'wallet_offer', 'wallet_pay', 'wallet_discover', 'wallet_budget_request', 'wallet_budget_delegate',
      'wallet_budget_disable', 'wallet_budgets', 'wallet_report', 'wallet_reconcile',
    ]);
    for (const t of WALLET_TOOLS) {
      expect(t.parameters.additionalProperties).toBe(false);
      expect(t.parameters.type).toBe('object');
      expect(['fetch', 'read', 'other']).toContain(t.kind);
      expect(typeof t.principalOnly).toBe('boolean');
      expect(t.description.length).toBeGreaterThan(40);
    }
    const props = (name: string) => (WALLET_TOOLS.find((t) => t.name === name)!.parameters as Out).properties;
    expect(props('wallet_budget_request').limit_usd.type).toBe('string');
    expect(props('wallet_pay').save_to).toMatchObject({ type: 'string', maxLength: 200 });
    expect(props('wallet_pay').save_to.description).toMatch(/sha256/);
    expect(props('wallet_pay').overwrite.type).toBe('boolean');
    expect(props('wallet_budget_delegate').per_call_usd.type).toBe('string');
    expect(props('wallet_discover').max_usd.type).toBe('string');
    expect(WALLET_TOOLS.find((t) => t.name === 'wallet_budget_request')!.principalOnly).toBe(true);
    expect(WALLET_TOOLS.find((t) => t.name === 'wallet_discover')).toMatchObject({ kind: 'read', principalOnly: false });
  });

  it('refuses a probe or a payment with no held budget, and bad arguments with code 2', async () => {
    const noBudget = await call('wallet_pay', { url: `${payee.url}/predict` }, { caller: PRINCIPAL });
    expect(noBudget.code).toBe(1);
    expect((noBudget.output as Out).error).toBe('mandate_required');
    expect((noBudget.output as Out).payment_model_context).toBeDefined();
    expect((noBudget.output as Out).host).toBe(new URL(payee.url).host);

    const bad = await call('wallet_pay', { url: 'not a url' }, { caller: PRINCIPAL });
    expect(bad.code).toBe(2);
    expect((bad.output as Out).error).toBe('config');
    const extra = await call('wallet_budgets', { nope: 1 }, { caller: PRINCIPAL });
    expect(extra.code).toBe(2);
    const unknown = await call('wallet_frobnicate', {}, { caller: PRINCIPAL });
    expect(unknown.code).toBe(2);
    const badAmount = await call('wallet_budget_request', { purpose: 'x', limit_usd: 'ten', hosts: ['127.0.0.1'] }, { caller: PRINCIPAL });
    expect(badAmount.code).toBe(2);
    expect((badAmount.output as Out).message).toMatch(/dollar amount/);
    const badFor = await call('wallet_budget_delegate', { parent_id: 'im_x', limit_usd: '1', for: { bots: true } }, { caller: PRINCIPAL });
    expect(badFor.code).toBe(2);
    const badCaller = await call('wallet_budgets', {}, { caller: { kind: 'wizard' } as unknown as Caller });
    expect(badCaller.code).toBe(2);
  });

  it('wallet_budget_request creates an approved budget for the principal only, projected without signature', async () => {
    const r = await call('wallet_budget_request', { purpose: 'quotes for the report', limit_usd: '0.01', hosts: ['127.0.0.1'], valid_for_hours: 2 }, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
    const m = (r.output as Out).mandate;
    expect(m.status).toBe('signed');
    expect(m.enabled).toBe(true);
    expect(m.limit_usd).toBe('0.010000');
    expect(m.remaining_usd).toBe('0.010000');
    expect(m.hosts).toEqual(['127.0.0.1']);
    expect(m.signature).toBeUndefined();
    expect(m.mandateHash).toBeUndefined();
    expect(m.holder).toBeUndefined();
    expect(new Date(m.valid_until).getTime() - new Date(m.valid_from).getTime()).toBe(2 * 3600 * 1000);
    rootId = m.id;

    const notPrincipal = await call('wallet_budget_request', { purpose: 'x', limit_usd: '1', hosts: ['127.0.0.1'] }, { caller: CHILD });
    expect(notPrincipal.code).toBe(2);
    expect((notPrincipal.output as Out).message).toMatch(/only the principal/);
  });

  it('wallet_offer sends no body or headers and reports amount_usd per offer', async () => {
    const before = payee.requests;
    const r = await call('wallet_offer', { url: `${payee.url}/analyze`, method: 'POST' }, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.status).toBe(402);
    expect(out.url).toBe(`${payee.url}/analyze`);
    expect(out.offer[0].amount_usd).toBe('0.001000');
    expect(out.offer[0].network).toBe('eip155:31337');
    expect(out.resource).toBe(`${payee.url}/analyze`);
    expect(out.payment_model_context.reason).toBe('payment_required');
    expect(payee.requests - before).toBe(1);
    expect(payee.payments.length).toBe(0);
    expect(payee.served).toBe(0);
    // The schema has no body/headers: a call that passes them is a usage error, not a leaked request.
    const withBody = await call('wallet_offer', { url: `${payee.url}/analyze`, body: '{"secret":1}' }, { caller: PRINCIPAL });
    expect(withBody.code).toBe(2);
    expect(payee.requests - before).toBe(1);
  });

  it('wallet_pay pays from the principal budget, adds url/host/resource/network/amounts and bounds the body', async () => {
    const r = await call('wallet_pay', { url: `${payee.url}/predict` }, { caller: PRINCIPAL, context: { session: 'parent-1', label: 'first' } });
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.status).toBe(200);
    expect(out.amount_usd).toBe('0.001000');
    expect(out.remaining_usd).toBe('0.009000');
    expect(out.mandate).toBe(rootId);
    expect(out.url).toBe(`${payee.url}/predict`);
    expect(out.host).toBe(new URL(payee.url).host);
    expect(out.resource).toBe('GET /predict');
    expect(out.network).toBe('eip155:31337');
    expect(out.ledger_status).toBe('settled');
    expect(out.context).toEqual({ session: 'parent-1', label: 'first' });
    expect(out.body.resource).toBe('GET /predict');
    expect(out.body_truncated).toBeUndefined();

    // A POST with a large echo: the body comes back cut at 8 KB and flagged.
    const big = JSON.stringify({ blob: 'x'.repeat(20_000) });
    const echoed = await call('wallet_pay', { url: `${payee.url}/analyze`, body: big, headers: { 'x-trace': 't1' } }, { caller: PRINCIPAL });
    expect(echoed.code).toBe(0);
    const e = echoed.output as Out;
    expect(e.paid).toBe(true);
    expect(e.resource).toBe('POST /analyze');
    expect(e.body_truncated).toBe(true);
    expect(typeof e.body).toBe('string');
    expect(Buffer.byteLength(e.body, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('wallet_budgets lists the caller\'s budgets with address, network and a degraded balance', async () => {
    const r = await call('wallet_budgets', {}, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.address).toBe(ctx.wallet().address);
    expect(out.network).toBe('eip155:31337');
    expect(out.balance.unavailable).toBeTruthy();
    expect(out.caller).toEqual({ kind: 'principal' });
    expect(out.mandates.map((m: Out) => m.id)).toEqual([rootId]);
    for (const m of out.mandates) {
      expect(m.signature).toBeUndefined();
      expect(m.mandateHash).toBeUndefined();
      expect(m.remaining_usd).toBe('0.008000'); // two payments of 0.001 so far
    }
    expect(JSON.stringify(out)).not.toMatch(/signature|mandateHash/);
    // A session holding nothing sees an empty list, not an error.
    expect(((await call('wallet_budgets', {}, { caller: PARENT })).output as Out).mandates).toEqual([]);
  });

  it('wallet_budget_delegate: the principal delegates to a session, the session to its children; bounds are refused', async () => {
    const toSession = await call('wallet_budget_delegate', { parent_id: rootId, limit_usd: '0.005', for: { session: 'parent-1' }, label: 'for the parent session' }, { caller: PRINCIPAL });
    expect(toSession.code).toBe(0);
    const s = (toSession.output as Out).mandate;
    expect(s.holder).toBe('session:parent-1');
    expect(s.parent_id).toBe(rootId);
    expect(s.purpose).toBe('for the parent session');
    expect(s.status).toBe('signed');
    expect(s.signature).toBeUndefined();

    // Out of bounds: more than the parent's remaining, and longer than 24 h.
    const tooMuch = await call('wallet_budget_delegate', { parent_id: s.id, limit_usd: '1', for: { children: true } }, { caller: PARENT, requesterSession: 'parent-1' });
    expect(tooMuch.code).toBe(1);
    expect((tooMuch.output as Out).message).toMatch(/exceeds the parent's effective remaining/);
    const tooLong = await call('wallet_budget_delegate', { parent_id: s.id, limit_usd: '0.001', for: { children: true }, valid_for_hours: 48 }, { caller: PARENT, requesterSession: 'parent-1' });
    expect(tooLong.code).toBe(1);
    expect((tooLong.output as Out).message).toMatch(/exceeds/);
    // Not the caller's to delegate.
    const notHeld = await call('wallet_budget_delegate', { parent_id: rootId, limit_usd: '0.001', for: { children: true } }, { caller: PARENT, requesterSession: 'parent-1' });
    expect(notHeld.code).toBe(2);
    expect((notHeld.output as Out).message).toMatch(/not held by session parent-1/);
    // children:true needs the host to say which session is asking.
    const noSession = await call('wallet_budget_delegate', { parent_id: s.id, limit_usd: '0.001', for: { children: true } }, { caller: PARENT });
    expect(noSession.code).toBe(2);

    const toChildren = await call('wallet_budget_delegate', { parent_id: s.id, limit_usd: '0.002', for: { children: true } }, { caller: PARENT, requesterSession: 'parent-1' });
    expect(toChildren.code).toBe(0);
    const c = (toChildren.output as Out).mandate;
    expect(c.holder).toBe('children:parent-1');
    expect(c.parent_id).toBe(s.id);
    expect(c.purpose).toBe('for the parent session (delegated)');
    expect(c.hosts).toEqual(['127.0.0.1']);
    expect(c.limit_usd).toBe('0.002000');
    childId = c.id;
  });

  it('a child pays from children:<parent>; the principal cannot spend a held budget', async () => {
    const r = await call('wallet_pay', { url: `${payee.url}/predict` }, { caller: CHILD, context: { session: 'kid-1', parentSession: 'parent-1' } });
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.mandate).toBe(childId);
    expect(out.remaining_usd).toBe('0.001000');
    // The chain was charged: the root's effective remaining moved too.
    const budgets = (await call('wallet_budgets', {}, { caller: PRINCIPAL })).output as Out;
    expect(budgets.mandates[0].remaining_usd).toBe('0.007000');

    const held = await call('wallet_pay', { url: `${payee.url}/predict`, mandate_id: childId }, { caller: PRINCIPAL });
    expect(held.code).toBe(1);
    expect((held.output as Out).error).toBe('holder_mismatch');
    expect((held.output as Out).payment_model_context).toBeDefined();
    // And a child sees only what was delegated to it.
    const mine = (await call('wallet_budgets', {}, { caller: CHILD })).output as Out;
    expect(mine.mandates.map((m: Out) => m.id)).toEqual([childId]);
    expect(mine.caller).toEqual({ kind: 'child', id: 'kid-1' });
  });

  it('wallet_budget_disable switches off a held (or delegated) budget and nothing more is paid from it', async () => {
    const stranger = await call('wallet_budget_disable', { id: rootId }, { caller: CHILD });
    expect(stranger.code).toBe(2);
    const r = await call('wallet_budget_disable', { id: childId }, { caller: PARENT }); // the delegator may switch it off
    expect(r.code).toBe(0);
    expect(r.output).toEqual({ ok: true, id: childId, enabled: false });
    const denied = await call('wallet_pay', { url: `${payee.url}/predict` }, { caller: CHILD });
    expect(denied.code).toBe(1);
    expect((denied.output as Out).error).toBe('mandate_disabled');
    const listed = (await call('wallet_budgets', {}, { caller: CHILD })).output as Out;
    expect(listed.mandates[0].enabled).toBe(false);
    const missing = await call('wallet_budget_disable', { id: 'im_nope' }, { caller: PRINCIPAL });
    expect(missing.code).toBe(2);
  });

  it('wallet_report and wallet_reconcile are principal-only envelopes', async () => {
    const report = await call('wallet_report', {}, { caller: PRINCIPAL });
    expect(report.code).toBe(0);
    const rep = (report.output as Out).report;
    expect(rep.totals.spentUsd).toBe('$0.003000'); // the SpendReport keeps the CLI's `$` convention
    expect(rep.bySessionUsd['parent-1']).toBe('$0.001000');
    expect(rep.bySessionUsd['kid-1']).toBe('$0.001000');
    expect((await call('wallet_report', {}, { caller: CHILD })).code).toBe(2);

    // The dead RPC leaves every settled row unverified (still pending on chain): the spec's flat counts come back.
    const rec = await call('wallet_reconcile', {}, { caller: PRINCIPAL });
    expect(rec.code).toBe(0);
    expect(rec.output).toEqual({ ok: true, settled: 0, expired_unused: 0, still_pending: 3, verified: 0 });
    expect((await call('wallet_reconcile', {}, { caller: CHILD })).code).toBe(2);
  });

  it('honours defaultValidForHours for requested budgets', async () => {
    const short = createWalletToolHandlers(ctx, { defaultValidForHours: 0.5 });
    const r = await short('wallet_budget_request', { purpose: 'short', limit_usd: '0.001', hosts: ['127.0.0.1'] }, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
    const m = (r.output as Out).mandate;
    expect(new Date(m.valid_until).getTime() - new Date(m.valid_from).getTime()).toBe(1800 * 1000);
  });

  it('wallet_offer on a free page answers {status, paid:false, note} with a bounded body; wallet_pay keeps the unknown-outcome hint', async () => {
    // Express answers 404 with an HTML page: not a 402, so no offer, and the body is bounded exactly like wallet_pay's.
    const free = await call('wallet_offer', { url: `${payee.url}/nope` }, { caller: PRINCIPAL });
    expect(free.code).toBe(0);
    const f = free.output as Out;
    expect(f.status).toBe(404);
    expect(f.paid).toBe(false);
    expect(f.note).toMatch(/did not ask for payment/);
    expect(f.url).toBe(`${payee.url}/nope`);
    expect(f.offer).toBeUndefined();
    expect(typeof f.body).toBe('string');
    expect(Buffer.byteLength(f.body, 'utf8')).toBeLessThanOrEqual(8 * 1024);

    // /raw answers 200 without a settlement report (the stub's default rawMode): the ledger row is `unknown`
    // and the model must read the same "reconcile before paying again" hint the CLI prints.
    const budget = await call('wallet_budget_request', { purpose: 'raw', limit_usd: '0.001', hosts: ['127.0.0.1'] }, { caller: PRINCIPAL });
    const id = (budget.output as Out).mandate.id as string;
    const r = await call('wallet_pay', { url: `${payee.url}/raw`, mandate_id: id }, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.status).toBe(200);
    expect(out.paid).toBe(false);
    expect(out.ledger_status).toBe('unknown');
    expect(out.mandate).toBe(id);
    expect(out.payment_model_context.reason).toBe('unknown');
    expect(out.payment_model_context.remediation.join(' ')).toMatch(/reconcile/i);
  });
});

describe('wallet_pay save_to', () => {
  let home: string;
  let saveRoot: string;
  let ctx: CommandContext;
  let call: WalletToolHandler;
  let payee: StubPayee;
  const meta = () => ({ caller: PRINCIPAL, context: { session: 'buyer-1' }, saveRoot });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-tools-save-'));
    saveRoot = join(home, 'vendor'); // does not exist yet: the first save creates it
    payee = await startStubPayee(stubOptions({ bigBytes: 100_000 }));
    const config = resolveConfig({}, {
      AGENTPAY_HOME: home,
      AGENTPAY_KEY: KEYS.payer,
      AGENTPAY_RPC: 'http://127.0.0.1:1',
      AGENTPAY_TOKEN: TOKEN,
      AGENTPAY_TOKEN_NAME: MOCK_USDC_DOMAIN.name,
      AGENTPAY_TOKEN_VERSION: MOCK_USDC_DOMAIN.version,
      AGENTPAY_NETWORK: 'eip155:31337',
    });
    ctx = new CommandContext(config, globalThis.fetch, () => {}, { requireMandateHost: true });
    call = createWalletToolHandlers(ctx);
    const r = await call('wallet_budget_request', { purpose: 'bars', limit_usd: '0.02', hosts: ['127.0.0.1'] }, { caller: PRINCIPAL });
    expect(r.code).toBe(0);
  });

  afterAll(async () => {
    ctx.dispose();
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('writes the whole body to <saveRoot>/<save_to>, answers with saved + a 1 KB preview and no body, and labels the ledger row', async () => {
    const r = await call('wallet_pay', { url: `${payee.url}/big`, save_to: 'massive/AAPL/2016.json' }, meta());
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(out.paid).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body).toBeUndefined();
    expect(out.body_truncated).toBeUndefined();
    const path = join(saveRoot, 'massive', 'AAPL', '2016.json');
    // Plan B: the relative path, never the host's directory layout (saveRoot stays the host's secret).
    expect(out.saved.path).toBe('massive/AAPL/2016.json');
    expect(JSON.stringify(out)).not.toContain(saveRoot);
    const file = readFileSync(path);
    expect(file.byteLength).toBe(100_000);
    expect(out.saved.bytes).toBe(100_000);
    expect(out.saved.sha256).toBe(createHash('sha256').update(file).digest('hex'));
    expect(out.saved.content_type).toMatch(/^application\/json/);
    expect(JSON.parse(file.toString('utf8')).rows[0].o).toBe(1); // the payee's bytes, verbatim
    expect(out.preview_truncated).toBe(true);
    expect(Buffer.byteLength(out.preview, 'utf8')).toBeLessThanOrEqual(PREVIEW_BYTES);
    expect(file.toString('utf8').startsWith(out.preview)).toBe(true);
    expect(readdirSync(join(saveRoot, 'massive', 'AAPL'))).toEqual(['2016.json']); // no temp file left
    // The file name is the payment's label: on the envelope and on the ledger row.
    expect(out.context).toEqual({ session: 'buyer-1', label: 'massive/AAPL/2016.json' });
    const row = ctx.ledger().read().find((e) => e.context?.label === 'massive/AAPL/2016.json');
    expect(row?.status).toBe('settled');
    // A label the host set wins over the file name.
    const labelled = await call('wallet_pay', { url: `${payee.url}/big`, save_to: 'massive/AAPL/2017.json' }, { ...meta(), context: { session: 'buyer-1', label: 'mine' } });
    expect((labelled.output as Out).context.label).toBe('mine');
    // The label and saved.path are the same normalised string, whatever the model's spelling.
    const spelt = await call('wallet_pay', { url: `${payee.url}/predict`, save_to: './massive/./AAPL/2018.json' }, meta());
    expect(spelt.code).toBe(0);
    expect((spelt.output as Out).saved.path).toBe('massive/AAPL/2018.json');
    expect((spelt.output as Out).context.label).toBe('massive/AAPL/2018.json');
    expect(existsSync(join(saveRoot, 'massive', 'AAPL', '2018.json'))).toBe(true);
    // A small body is saved too, previewed whole.
    const small = await call('wallet_pay', { url: `${payee.url}/predict`, save_to: 'small.json' }, meta());
    expect(small.code).toBe(0);
    expect((small.output as Out).preview_truncated).toBe(false);
    expect(JSON.parse((small.output as Out).preview).resource).toBe('GET /predict');
    expect((small.output as Out).body).toBeUndefined();
  });

  it('reports a write that fails after the payment on the envelope, never as a throw naming the host', async () => {
    if (process.getuid?.() === 0) return; // root ignores modes: the EACCES below cannot be produced
    const ro = join(saveRoot, 'ro');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    try {
      const r = await call('wallet_pay', { url: `${payee.url}/predict`, save_to: 'ro/x.json' }, meta());
      expect(r.code).toBe(0);
      const out = r.output as Out;
      expect(out.paid).toBe(true); // the money moved; the receipt says so
      expect(out.saved).toMatchObject({ error: 'write_failed', path: 'ro/x.json', code: 'EACCES' });
      expect(out.preview).toBeTypeOf('string');
      expect(out.body).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain(saveRoot); // the failure names no host directory
      expect(existsSync(join(ro, 'x.json'))).toBe(false);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it('refuses every unsafe path and a missing saveRoot with code 2 before any request is sent', async () => {
    const before = payee.requests;
    const refused = async (args: Out, m: Out, why: RegExp) => {
      const r = await call('wallet_pay', { url: `${payee.url}/big`, ...args }, m as never);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect((r.output as Out).message, JSON.stringify(args)).toMatch(why);
      expect((r.output as Out).host).toBe(new URL(payee.url).host);
    };
    await refused({ save_to: '../x.json' }, meta(), /"\.\." segment/);
    await refused({ save_to: 'a/../../x.json' }, meta(), /"\.\." segment/);
    await refused({ save_to: '/tmp/x.json' }, meta(), /absolute/);
    await refused({ save_to: 'C:\\x.json' }, meta(), /Windows drive/);
    await refused({ save_to: '\\\\srv\\share\\x.json' }, meta(), /UNC/);
    await refused({ save_to: '' }, meta(), /non-empty/);
    await refused({ save_to: 'x'.repeat(201) }, meta(), /longer than 200/);
    await refused({ save_to: 'a\0b.json' }, meta(), /NUL/);
    await refused({ save_to: 'massive/AAPL/2016.json' }, meta(), /exists; pass overwrite/);
    await refused({ save_to: 'massive/AAPL/2016.json/inner.json' }, meta(), /existing file/);
    await refused({ save_to: 'x.json', overwrite: 'yes' }, meta(), /overwrite must be a boolean/);
    await refused({ save_to: 'x.json' }, { caller: PRINCIPAL }, /save directory.*host gave this session none/);
    expect(payee.requests).toBe(before);
    expect(existsSync(join(saveRoot, 'x.json'))).toBe(false);
    // Outside the root through a symlink: the directory exists inside, its target does not.
    const outside = join(home, 'elsewhere');
    mkdirSync(outside);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(saveRoot, 'link'));
    await refused({ save_to: 'link/x.json' }, meta(), /symlink/);
    expect(payee.requests).toBe(before);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('overwrite:true replaces the file', async () => {
    const path = join(saveRoot, 'massive', 'AAPL', '2016.json');
    writeFileSync(path, 'stale');
    const r = await call('wallet_pay', { url: `${payee.url}/big`, save_to: 'massive/AAPL/2016.json', overwrite: true }, meta());
    expect(r.code).toBe(0);
    expect((r.output as Out).saved.bytes).toBe(100_000);
    expect(readFileSync(path).byteLength).toBe(100_000);
  });

  it('a handler 500 writes nothing and is reported as without save_to', async () => {
    const failing = await startStubPayee(stubOptions({ bigBytes: 100_000, handlerStatus: 500 }));
    try {
      const r = await call('wallet_pay', { url: `${failing.url}/big`, save_to: 'failed.json' }, meta());
      expect(r.code).toBe(1);
      expect((r.output as Out).status).toBe(500); // PayeeRejected, exactly as without save_to
      expect((r.output as Out).saved).toBeUndefined();
      expect(existsSync(join(saveRoot, 'failed.json'))).toBe(false);
      expect(readdirSync(saveRoot).filter((f) => f.includes('tmp-'))).toEqual([]);
    } finally {
      await failing.close();
    }
  });
});
