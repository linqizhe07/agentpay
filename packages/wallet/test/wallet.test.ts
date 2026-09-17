import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HEADER,
  PolicyViolation,
  WireError,
  mandateDigest,
  recoverMandateSigner,
  resourceRef,
  type Address,
  type Hex,
} from '@agentpay/core';
import {
  INTENT_DOMAIN,
  INTENT_MANDATE_TYPES,
  IntentMandateStore,
  Ledger,
  MandateWallet,
  intentMandateHash,
  matchHost,
  recoverIntentMandateSigner,
  type IntentMandateInput,
  type LedgerEntry,
  type MandateWalletOptions,
} from '../src/index.js';
import { KEYS, startStubPayee, type StubPayee, type StubPayeeOptions } from './stub-payee.js';

const NETWORK = 'eip155:31337';
const CHAIN_ID = 31337;
const WALLET = ('0x' + '22'.repeat(20)) as Address;
const TOKEN = ('0x' + '11'.repeat(20)) as Address;
const PRICE = '1000'; // $0.001
const SETTLE_WINDOW = 600;
const payerAccount = privateKeyToAccount(KEYS.payer);
const spAddress = privateKeyToAccount(KEYS.sp).address;
const strangerAddress = privateKeyToAccount(KEYS.stranger).address;

const root = mkdtempSync(join(tmpdir(), 'agentpay-wallet-test-'));
let n = 0;

interface Made {
  wallet: MandateWallet;
  dir: string;
  mandatesPath: string;
  ledgerPath: string;
  account: ReturnType<typeof privateKeyToAccount>;
}

function makeWallet(over: Partial<MandateWalletOptions> = {}): Made {
  const dir = join(root, `w${n++}`);
  const mandatesPath = join(dir, 'mandates.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  const account = over.account ?? privateKeyToAccount(KEYS.payer);
  const wallet = new MandateWallet({
    account,
    rpcUrl: 'http://127.0.0.1:1', // never reachable; offline suite
    walletContract: WALLET,
    token: TOKEN,
    network: NETWORK,
    mandatesPath,
    ledgerPath,
    ...over,
  });
  return { wallet, dir, mandatesPath, ledgerPath, account };
}

const servers: StubPayee[] = [];
async function serve(over: Partial<StubPayeeOptions> = {}): Promise<StubPayee> {
  const s = await startStubPayee({
    payeeKey: KEYS.payee,
    spKey: KEYS.sp,
    wallet: WALLET,
    token: TOKEN,
    network: NETWORK,
    price: PRICE,
    settleWindowSeconds: SETTLE_WINDOW,
    ...over,
  });
  servers.push(s);
  return s;
}
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const baseInput = (over: Partial<IntentMandateInput> = {}): IntentMandateInput => ({
  naturalLanguage: 'market data for the report',
  limitAmount: '$1',
  validForSeconds: 3600,
  hostAllowlist: ['127.0.0.1'],
  ...over,
});

async function approved(wallet: MandateWallet, over: Partial<IntentMandateInput> = {}) {
  return wallet.createIntentMandate(baseInput(over), { approve: true });
}

function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

async function expectViolation(p: Promise<unknown>, reason: string): Promise<PolicyViolation> {
  const err = await p.then(
    () => {
      throw new Error(`expected PolicyViolation(${reason}), but the call resolved`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PolicyViolation);
  expect((err as PolicyViolation).reason).toBe(reason);
  expect((err as PolicyViolation).payment_model_context?.reason).toBe(reason);
  expect((err as PolicyViolation).payment_model_context?.protocol).toBe('aep2');
  return err as PolicyViolation;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------

describe('matchHost', () => {
  it('exact, exact with port, wildcard subdomains, and the catch-all', () => {
    expect(matchHost('api.example.com', 'api.example.com')).toBe(true);
    expect(matchHost('API.Example.com', 'api.example.com')).toBe(true);
    expect(matchHost('api.example.com', 'api.example.com:8080')).toBe(false);
    expect(matchHost('api.example.com:8080', 'api.example.com:8080')).toBe(true);
    expect(matchHost('api.example.com:8080', 'api.example.com')).toBe(false);
    expect(matchHost('*.example.com', 'api.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'evil-example.com')).toBe(false);
    expect(matchHost('*.example.com:8080', 'api.example.com:8080')).toBe(true);
    expect(matchHost('*', 'anything.at.all')).toBe(true);
    expect(matchHost('', 'x')).toBe(false);
  });
});

describe('Ledger', () => {
  it('appends, reads back, and patches status by digest', () => {
    const ledger = new Ledger(join(root, 'ledger-unit', 'ledger.jsonl'));
    const entry = {
      kind: 'payment',
      timestamp: 1,
      url: 'http://x/y',
      host: 'x',
      resource: 'GET /y',
      network: NETWORK,
      asset: TOKEN,
      amount: '5',
      payer: payerAccount.address,
      payee: strangerAddress,
      walletContract: WALLET,
      intentMandateId: 'im_1',
      mandate: {
        owner: payerAccount.address,
        token: TOKEN,
        payee: strangerAddress,
        amount: '5',
        nonce: '1',
        deadline: 2,
        ref: resourceRef('GET /y'),
      },
      payerSig: '0x' as Hex,
      mandateDigest: ('0x' + 'ab'.repeat(32)) as Hex,
      httpStatus: 200,
      status: 'enqueued',
    } satisfies LedgerEntry;
    expect(ledger.read()).toEqual([]);
    ledger.append(entry);
    ledger.append({ ...entry, mandateDigest: ('0x' + 'cd'.repeat(32)) as Hex });
    expect(ledger.read()).toHaveLength(2);
    ledger.updateStatus(entry.mandateDigest, 'settled', { settledTx: ('0x' + '01'.repeat(32)) as Hex });
    const [a, b] = ledger.read();
    expect(a.status).toBe('settled');
    expect(a.settledTx).toBe('0x' + '01'.repeat(32));
    expect(b.status).toBe('enqueued');
    expect(() => ledger.updateStatus(('0x' + 'ee'.repeat(32)) as Hex, 'settled')).toThrow(/no ledger entry/);
  });
});

describe('IntentMandateStore', () => {
  it('persists via temp file + rename and reloads', () => {
    const path = join(root, 'store-unit', 'mandates.json');
    const store = new IntentMandateStore(path);
    expect(store.list()).toEqual([]);
    const m = {
      id: 'im_test',
      naturalLanguage: 'x',
      currency: 'USDC' as const,
      limitAmount: '10',
      hostAllowlist: ['a'],
      validFrom: 1,
      validUntil: 2,
      spentAmount: '0',
      pendingSpentAmount: '0',
      status: 'draft' as const,
      isEnabled: true,
      mandateHash: '0x' as Hex,
      createdAt: 1,
    };
    store.upsert(m);
    expect(existsSync(path)).toBe(false); // upsert is memory-only
    store.save();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(root, 'store-unit')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(new IntentMandateStore(path).get('im_test')).toEqual(m);
    expect(new IntentMandateStore().list()).toEqual([]); // memory store
  });
});

// ---------------------------------------------------------------------------

describe('intent mandate lifecycle', () => {
  it('creates a draft, refuses to spend against it, approves with a verifiable EIP-712 signature', async () => {
    const s = await serve();
    const { wallet, mandatesPath } = makeWallet();
    const draft = await wallet.createIntentMandate(baseInput({ limitAmount: '$2.5', category: 'data' }));
    expect(draft.id).toMatch(/^im_[0-9a-f]{12}$/);
    expect(draft.status).toBe('draft');
    expect(draft.signature).toBeUndefined();
    expect(draft.limitAmount).toBe('2500000');
    expect(draft.currency).toBe('USDC');
    expect(draft.validUntil - draft.validFrom).toBe(3600);
    expect(draft.mandateHash).toBe(intentMandateHash(CHAIN_ID, draft));
    expect(draft.mandateHash).toBe(
      hashTypedData({
        domain: { ...INTENT_DOMAIN, chainId: CHAIN_ID },
        types: INTENT_MANDATE_TYPES,
        primaryType: 'IntentMandate',
        message: {
          id: draft.id,
          naturalLanguage: draft.naturalLanguage,
          limitAmount: 2_500_000n,
          validFrom: BigInt(draft.validFrom),
          validUntil: BigInt(draft.validUntil),
          hostAllowlist: '127.0.0.1',
          category: 'data',
        },
      }),
    );
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n })).toEqual({
      eligible: [],
      rejected: [{ id: draft.id, reason: 'mandate_required', detail: expect.anything() }],
    });
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_required');
    expect(s.mandates).toHaveLength(0);

    const signed = await wallet.approveIntentMandate(draft.id);
    expect(signed.status).toBe('signed');
    expect(signed.signedAt).toBeGreaterThan(0);
    expect(await recoverIntentMandateSigner(CHAIN_ID, signed, signed.signature!)).toBe(wallet.address);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n }).eligible.map((m) => m.id)).toEqual([
      draft.id,
    ]);
    // eligibleMandates accepts host:port too and matches on the bare hostname
    expect(wallet.eligibleMandates({ host: '127.0.0.1:8080', amount: 1000n }).eligible).toHaveLength(1);
    expect(wallet.remaining(draft.id)).toBe(2_500_000n);

    // approving twice is idempotent; the persisted file has the signature
    expect((await wallet.approveIntentMandate(draft.id)).signature).toBe(signed.signature);
    expect(new IntentMandateStore(mandatesPath).get(draft.id)?.signature).toBe(signed.signature);

    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(200);
    expect(wallet.remaining(draft.id)).toBe(2_499_000n);
  });

  it('validates input', async () => {
    const { wallet } = makeWallet();
    await expect(wallet.createIntentMandate(baseInput({ validForSeconds: 31_536_001 }))).rejects.toThrow(RangeError);
    await expect(wallet.createIntentMandate(baseInput({ validForSeconds: 0 }))).rejects.toThrow(RangeError);
    await expect(wallet.createIntentMandate(baseInput({ limitAmount: 'abc' }))).rejects.toThrow(WireError);
    await expect(wallet.createIntentMandate(baseInput({ hostAllowlist: [] }))).rejects.toThrow(TypeError);
    await expect(wallet.createIntentMandate(baseInput({ perCallMax: '$5' }))).rejects.toThrow(RangeError);
    await expect(wallet.createIntentMandate(baseInput({ naturalLanguage: ' ' }))).rejects.toThrow(TypeError);
    const ok = await wallet.createIntentMandate(baseInput({ limitAmount: '250000', perCallMax: '$0.1' }));
    expect(ok.limitAmount).toBe('250000');
    expect(ok.perCallMax).toBe('100000');
    expect(wallet.getMandate(ok.id)?.id).toBe(ok.id);
    expect(wallet.listMandates()).toHaveLength(1);
    expect(() => wallet.remaining('im_nope')).toThrow(/no intent mandate/);
  });

  it('setEnabled toggles and persists', async () => {
    const { wallet, mandatesPath } = makeWallet();
    const m = await approved(wallet);
    expect(wallet.setEnabled(m.id, false).isEnabled).toBe(false);
    expect(new IntentMandateStore(mandatesPath).get(m.id)?.isEnabled).toBe(false);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1n }).rejected[0].reason).toBe('mandate_disabled');
    expect(wallet.setEnabled(m.id, true).isEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('policy gate: every PolicyReason fires BEFORE signTypedData', () => {
  it('unsupported_offer (no aep2 offer for this wallet token)', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet({ token: strangerAddress });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'unsupported_offer');
    expect(err.detail?.offered).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(s.mandates).toHaveLength(0);
  });

  it('unsupported_offer when the offer names another debit-wallet contract or network', async () => {
    const other = await serve({ wallet: strangerAddress });
    const { wallet, account } = makeWallet();
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    await expectViolation(wallet.fetch(`${other.url}/predict`), 'unsupported_offer');
    const otherNet = await serve({ network: 'eip155:84532' });
    await expectViolation(wallet.fetch(`${otherNet.url}/predict`), 'unsupported_offer');
    expect(spy).not.toHaveBeenCalled();
  });

  it('sp_not_trusted', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet({ trustedSps: [strangerAddress] });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'sp_not_trusted');
    expect(err.detail?.spAddress).toBe(spAddress);
    expect(spy).not.toHaveBeenCalled();
    // a trust list containing the SP (any case) passes
    const trusting = makeWallet({ trustedSps: [spAddress.toLowerCase() as Address] });
    await approved(trusting.wallet);
    expect((await trusting.wallet.fetch(`${s.url}/predict`)).status).toBe(200);
  });

  it('per_call_max via caps', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet({ caps: { perCallMaxAtomic: 999n } });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'per_call_max');
    expect(err.detail).toEqual({ amount: '1000', perCallMax: '999' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rate_limited via caps on a sliding 60s window, recovering after it passes', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, account } = makeWallet({ caps: { maxCallsPerMinute: 1 }, now: () => t });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'rate_limited');
    expect(spy).toHaveBeenCalledTimes(1);
    t += 61;
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
  });

  it('mandate_required when nothing is signed (none at all, or drafts only)', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    const spy = vi.spyOn(account, 'signTypedData');
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_required');
    await wallet.createIntentMandate(baseInput());
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('host_not_allowed', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    await approved(wallet, { hostAllowlist: ['api.example.com', '*.example.org'] });
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'host_not_allowed');
    expect(err.detail?.host).toBe(new URL(s.url).host);
    expect(spy).not.toHaveBeenCalled();
  });

  it('mandate_expired (window passed, and also not yet valid)', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, account } = makeWallet({ now: () => t });
    const m = await approved(wallet, { validForSeconds: 100 });
    const spy = vi.spyOn(account, 'signTypedData');
    t += 100; // validUntil is exclusive
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_expired');
    t -= 101; // before validFrom
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_expired');
    expect(err.detail?.mandateId).toBe(m.id);
    expect(spy).not.toHaveBeenCalled();
  });

  it('per_call_max via the mandate', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    await approved(wallet, { perCallMax: '999' });
    const spy = vi.spyOn(account, 'signTypedData');
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'per_call_max');
    expect(spy).not.toHaveBeenCalled();
  });

  it('mandate_insufficient_budget', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    const m = await approved(wallet, { limitAmount: '999' });
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_insufficient_budget');
    expect(err.detail).toMatchObject({ mandateId: m.id, amount: '1000', remaining: '999' });
    expect(err.payment_model_context?.summary).toContain('999');
    expect(spy).not.toHaveBeenCalled();
    expect(wallet.remaining(m.id)).toBe(999n); // nothing reserved
  });

  it('rate_limited via the mandate', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, account } = makeWallet({ now: () => t });
    await approved(wallet, { maxCallsPerMinute: 2 });
    const spy = vi.spyOn(account, 'signTypedData');
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'rate_limited');
    expect(spy).toHaveBeenCalledTimes(2);
    t += 61;
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
  });

  it('explicit mandateId: not found / disabled / draft / host / budget, even when another mandate is eligible', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    const good = await approved(wallet);
    const wrongHost = await approved(wallet, { hostAllowlist: ['api.example.com'] });
    const tiny = await approved(wallet, { limitAmount: '10' });
    const disabled = await approved(wallet);
    wallet.setEnabled(disabled.id, false);
    const draft = await wallet.createIntentMandate(baseInput());
    const spy = vi.spyOn(account, 'signTypedData');

    const nf = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: 'im_missing' }), 'mandate_not_found');
    expect(nf.detail).toEqual({ mandateId: 'im_missing' });
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: disabled.id }), 'mandate_disabled');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: draft.id }), 'mandate_required');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: wrongHost.id }), 'host_not_allowed');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: tiny.id }), 'mandate_insufficient_budget');
    expect(spy).not.toHaveBeenCalled();
    for (const m of [good, wrongHost, tiny, disabled, draft]) expect(wallet.remaining(m.id)).toBe(BigInt(m.limitAmount));

    // and the explicit id is the one charged
    const res = await wallet.fetch(`${s.url}/predict`, undefined, { mandateId: good.id });
    expect(res.status).toBe(200);
    expect(wallet.remaining(good.id)).toBe(999_000n);
    expect(wallet.report().policyDenials.map((d) => d.reason)).toEqual([
      'mandate_not_found',
      'mandate_disabled',
      'mandate_required',
      'host_not_allowed',
      'mandate_insufficient_budget',
    ]);
  });

  it('denials carry payment_model_context and are listed in report().policyDenials', async () => {
    const s = await serve();
    const t = nowSec();
    const { wallet } = makeWallet({ now: () => t, caps: { perCallMaxAtomic: 1n } });
    const m = await approved(wallet, { limitAmount: '10' });
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'per_call_max');
    const caps = makeWallet({ now: () => t });
    await expectViolation(caps.wallet.fetch(`${s.url}/predict`, undefined, { mandateId: m.id }), 'mandate_not_found');
    expect(wallet.report().policyDenials).toEqual([{ reason: 'per_call_max', url: `${s.url}/predict`, timestamp: t }]);
    expect(caps.wallet.report().policyDenials).toEqual([
      { reason: 'mandate_not_found', url: `${s.url}/predict`, mandateId: m.id, timestamp: t },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('auto-selection', () => {
  it('surfaces rejection reasons by precedence: host_not_allowed > mandate_expired > per_call_max > budget > rate', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet } = makeWallet({ now: () => t });
    const expired = await approved(wallet, { validForSeconds: 10 });
    t += 11;
    const badHost = await approved(wallet, { hostAllowlist: ['api.example.com'] });
    const small = await approved(wallet, { perCallMax: '1' });
    const broke = await approved(wallet, { limitAmount: '5' });
    const busy = await approved(wallet, { maxCallsPerMinute: 1 });
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200); // consumes busy's one call

    const q = { host: '127.0.0.1', amount: 1000n };
    const { eligible, rejected } = wallet.eligibleMandates(q);
    expect(eligible).toEqual([]);
    expect(Object.fromEntries(rejected.map((r) => [r.id, r.reason]))).toEqual({
      [expired.id]: 'mandate_expired',
      [badHost.id]: 'host_not_allowed',
      [small.id]: 'per_call_max',
      [broke.id]: 'mandate_insufficient_budget',
      [busy.id]: 'rate_limited',
    });
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'host_not_allowed');
    wallet.setEnabled(badHost.id, false); // disabled ranks last
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_expired');
    wallet.setEnabled(expired.id, false);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'per_call_max');
    wallet.setEnabled(small.id, false);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_insufficient_budget');
    wallet.setEnabled(broke.id, false);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'rate_limited');
    wallet.setEnabled(busy.id, false);
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_disabled');
    expect(s.served).toBe(1);
  });

  it('spends the mandate that expires first', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    const late = await approved(wallet, { validForSeconds: 7200 });
    const soon = await approved(wallet, { validForSeconds: 600 });
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n }).eligible.map((m) => m.id)).toEqual([
      soon.id,
      late.id,
    ]);
    await wallet.fetch(`${s.url}/predict`);
    expect(wallet.remaining(soon.id)).toBe(999_000n);
    expect(wallet.remaining(late.id)).toBe(1_000_000n);
  });
});

// ---------------------------------------------------------------------------

describe('payment happy path + budget accounting', () => {
  it('pays, verifies the SP receipt, commits the reservation, writes the ledger, persists the budget', async () => {
    const s = await serve();
    const t = nowSec();
    const { wallet, ledgerPath, mandatesPath } = makeWallet({ now: () => t });
    const m = await approved(wallet, { limitAmount: '$0.01' });

    const res = await wallet.fetch(`${s.url}/predict?symbol=ETH`, { headers: { 'x-trace': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADER.response)).toBeTruthy();
    expect(await res.json()).toEqual({ ok: true, resource: 'GET /predict', served: 1 });
    expect(s.served).toBe(1);
    expect(s.requests).toBe(2); // 402 then paid

    // budget: reservation converted to spend
    const stored = wallet.getMandate(m.id)!;
    expect(stored.spentAmount).toBe('1000');
    expect(stored.pendingSpentAmount).toBe('0');
    expect(wallet.remaining(m.id)).toBe(9000n);

    // the stub verified a mandate that recovers to the payer
    const [{ mandate, payerSig }] = s.mandates;
    expect(mandate.owner).toBe(wallet.address);
    expect(mandate.token).toBe(TOKEN);
    expect(mandate.payee).toBe(s.address);
    expect(mandate.amount).toBe('1000');
    expect(mandate.deadline).toBe(t + SETTLE_WINDOW + 60);
    expect(mandate.ref).toBe(resourceRef('GET /predict'));
    const domain = { chainId: CHAIN_ID, verifyingContract: WALLET };
    expect(await recoverMandateSigner(domain, mandate, payerSig)).toBe(wallet.address);

    // ledger entry shape
    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e).toMatchObject({
      kind: 'payment',
      timestamp: t,
      url: `${s.url}/predict?symbol=ETH`,
      host: new URL(s.url).host,
      resource: 'GET /predict',
      network: NETWORK,
      asset: TOKEN,
      amount: '1000',
      payer: wallet.address,
      payee: s.address,
      walletContract: WALLET,
      intentMandateId: m.id,
      mandate,
      payerSig,
      mandateDigest: mandateDigest(domain, mandate),
      httpStatus: 200,
      status: 'enqueued',
    });
    expect(e.spReceipt?.sp).toBe(spAddress);
    expect(e.spReceipt?.mandateDigest).toBe(e.mandateDigest);
    expect(e.spReceipt?.enqueueDeadline).toBeLessThanOrEqual(mandate.deadline);
    expect(e.error).toBeUndefined();

    // a second wallet over the same files sees the same budget and ledger
    const again = new MandateWallet({
      key: KEYS.payer,
      rpcUrl: 'http://127.0.0.1:1',
      walletContract: WALLET,
      token: TOKEN,
      network: NETWORK,
      mandatesPath,
      ledgerPath,
      now: () => t,
    });
    expect(again.remaining(m.id)).toBe(9000n);
    expect(again.report().totals).toMatchObject({ spent: '1000', pending: '0', enqueued: 1 });
    await again.fetch(`${s.url}/predict`);
    expect(again.remaining(m.id)).toBe(8000n);
    expect(wallet.report().totals.enqueued).toBe(2); // ledger is shared…
    expect(new IntentMandateStore(mandatesPath).get(m.id)?.spentAmount).toBe('2000'); // …and so is the store
  });

  it('the request body is re-sent with the mandate, and the offer ref honours quoteId', async () => {
    const s = await serve({ resource: 'POST /analyze', quoteId: 'q-42', mode: { bodyPayment: true } });
    const { wallet } = makeWallet();
    await approved(wallet);
    const res = await wallet.fetch(`${s.url}/analyze`, { method: 'POST', body: '{"text":"hi"}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payment?: { status: string; spReceipt: { sp: string } } };
    expect(body.payment?.status).toBe('enqueued');
    expect(body.payment?.spReceipt.sp).toBe(spAddress);
    expect(s.mandates[0].mandate.ref).toBe(resourceRef('POST /analyze', 'q-42'));
    expect(wallet.report().byResource['POST /analyze']).toBe('1000');
  });

  it('non-402 responses pass through untouched and cost nothing', async () => {
    const s = await serve();
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wallet.remaining(m.id)).toBe(1_000_000n);
    expect(readLedger(ledgerPath)).toEqual([]);
    expect((await wallet.fetch(`${s.url}/nope`)).status).toBe(404);
  });

  it('a 402 without a usable offer is a WireError, not a payment', async () => {
    const { wallet } = makeWallet({
      fetch: async () => new Response('nope', { status: 402 }),
    });
    await approved(wallet);
    await expect(wallet.fetch('http://127.0.0.1:9/x')).rejects.toBeInstanceOf(WireError);
  });

  it('a signing failure releases the reservation and rethrows', async () => {
    const s = await serve();
    const { wallet, account, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    vi.spyOn(account, 'signTypedData').mockRejectedValueOnce(new Error('signer unavailable'));
    await expect(wallet.fetch(`${s.url}/predict`)).rejects.toThrow('signer unavailable');
    expect(wallet.getMandate(m.id)?.pendingSpentAmount).toBe('0');
    expect(wallet.remaining(m.id)).toBe(1_000_000n);
    expect(readLedger(ledgerPath)).toEqual([]);
    expect(s.mandates).toHaveLength(0);
  });

  it('caps.maxMandateValiditySeconds bounds the deadline horizon', async () => {
    const s = await serve({ settleWindowSeconds: 120 });
    const t = nowSec();
    const { wallet } = makeWallet({ now: () => t, caps: { maxMandateValiditySeconds: 150 } });
    await approved(wallet);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(s.mandates[0].mandate.deadline).toBe(t + 150); // min(120 + 60, 150)
  });
});

// ---------------------------------------------------------------------------

describe('SP receipt verification', () => {
  for (const receipt of ['missing', 'bad-sig', 'wrong-sp', 'late-deadline'] as const) {
    it(`${receipt} receipt -> ledger 'unknown', but the budget is still spent`, async () => {
      const s = await serve({ mode: { receipt } });
      const { wallet, ledgerPath } = makeWallet();
      const m = await approved(wallet);
      const res = await wallet.fetch(`${s.url}/predict`);
      expect(res.status).toBe(200);
      const [e] = readLedger(ledgerPath);
      expect(e.status).toBe('unknown');
      expect(e.httpStatus).toBe(200);
      if (receipt === 'missing') {
        expect(e.spReceipt).toBeUndefined();
        expect(e.error).toBe('missing sp receipt');
      } else {
        expect(e.spReceipt).toBeDefined();
        expect(e.error).toMatch(/^invalid_sp_receipt: (bad_signature|sp_mismatch|deadline_too_far|deadline_after_mandate)$/);
      }
      expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
      expect(wallet.report().totals).toMatchObject({ unknown: 1, enqueued: 0, spent: '1000' });
    });
  }

  it('a malformed PAYMENT-RESPONSE header -> unknown', async () => {
    const s = await serve();
    const { wallet, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        const res = await globalThis.fetch(input, init);
        if (!res.headers.has(HEADER.response)) return res;
        const headers = new Headers(res.headers);
        headers.set(HEADER.response, '%%%not-base64-json');
        return new Response(await res.arrayBuffer(), { status: res.status, headers });
      },
    });
    await approved(wallet);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    const [e] = readLedger(ledgerPath);
    expect(e.status).toBe('unknown');
    expect(e.error).toMatch(/malformed PAYMENT-RESPONSE/);
  });

  it('requireReceipt: false keeps a missing receipt as enqueued (invalid ones stay unknown)', async () => {
    const missing = await serve({ mode: { receipt: 'missing' } });
    const bad = await serve({ mode: { receipt: 'bad-sig' } });
    const { wallet, ledgerPath } = makeWallet({ caps: { requireReceipt: false } });
    await approved(wallet);
    await wallet.fetch(`${missing.url}/predict`);
    await wallet.fetch(`${bad.url}/predict`);
    const [a, b] = readLedger(ledgerPath);
    expect(a.status).toBe('enqueued');
    expect(b.status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------

describe('refusals after signing', () => {
  it('non-2xx -> ledger rejected with the body error, reservation KEPT, response returned', async () => {
    const s = await serve({
      mode: { reject: { status: 402, body: { error: 'settlement_unavailable: sp_not_authorized' } } },
    });
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'settlement_unavailable: sp_not_authorized' });
    const [e] = readLedger(ledgerPath);
    expect(e.status).toBe('rejected');
    expect(e.httpStatus).toBe(402);
    expect(e.error).toBe('settlement_unavailable: sp_not_authorized');
    expect(e.spReceipt).toBeUndefined();
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
    expect(wallet.remaining(m.id)).toBe(999_000n);
    expect(wallet.report().totals).toMatchObject({ rejected: 1, pending: '1000', spent: '0' });
    expect(wallet.report().byHost).toEqual({}); // rejected is not spend
  });

  it('a payee that refuses the x402 envelope answers 402 again: recorded, not retried', async () => {
    const s = await serve({ mode: { legacyOnly: true } });
    const { wallet, ledgerPath } = makeWallet();
    await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(402);
    expect(s.offersSent).toBe(2);
    expect(readLedger(ledgerPath)[0].status).toBe('rejected');
  });

  it('409 replay -> SP /status says pending -> treated as enqueued (pending -> spent)', async () => {
    const s = await serve({ mode: { replay409: true, spStatus: 'pending' } });
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('replay');
    const [e] = readLedger(ledgerPath);
    expect(e.status).toBe('enqueued');
    expect(e.httpStatus).toBe(409);
    expect(e.error).toMatch(/replay; sp status pending/);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
  });

  it('409 replay -> SP /status unknown (404) or terminal -> rejected, reservation kept', async () => {
    const s404 = await serve({ mode: { replay409: true } });
    const sFailed = await serve({ mode: { replay409: true, spStatus: 'failed' } });
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    expect((await wallet.fetch(`${s404.url}/predict`)).status).toBe(409);
    expect((await wallet.fetch(`${sFailed.url}/predict`)).status).toBe(409);
    const [a, b] = readLedger(ledgerPath);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '2000' });
  });

  it('a network error on the paid retry -> ledger unknown (httpStatus 0), reservation kept, error rethrown', async () => {
    const s = await serve();
    const { wallet, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        if (new Headers(init?.headers).has(HEADER.signature)) throw new TypeError('fetch failed: ECONNRESET');
        return globalThis.fetch(input, init);
      },
    });
    const m = await approved(wallet);
    await expect(wallet.fetch(`${s.url}/predict`)).rejects.toThrow('ECONNRESET');
    const [e] = readLedger(ledgerPath);
    expect(e.status).toBe('unknown');
    expect(e.httpStatus).toBe(0);
    expect(e.error).toMatch(/^network: /);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
  });

  it('reconcile() with an unreachable RPC keeps everything pending', async () => {
    const s = await serve({ mode: { reject: { status: 500, body: { error: 'boom' } } } });
    const { wallet } = makeWallet();
    const m = await approved(wallet);
    await wallet.fetch(`${s.url}/predict`);
    const r = await wallet.reconcile();
    expect(r.settled).toEqual([]);
    expect(r.expiredUnused).toEqual([]);
    expect(r.stillPending).toHaveLength(1);
    expect(wallet.remaining(m.id)).toBe(999_000n);
  });
});

// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('parallel fetch() calls cannot overshoot a limit: budget for N-1 of N -> exactly one PolicyViolation', async () => {
    const s = await serve();
    const N = 6;
    const { wallet } = makeWallet();
    const m = await approved(wallet, { limitAmount: String(1000 * (N - 1)) });
    const results = await Promise.allSettled(Array.from({ length: N }, () => wallet.fetch(`${s.url}/predict`)));
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
    const denied = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof PolicyViolation,
    );
    expect(ok).toHaveLength(N - 1);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason.reason).toBe('mandate_insufficient_budget');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: String(1000 * (N - 1)), pendingSpentAmount: '0' });
    expect(wallet.remaining(m.id)).toBe(0n);
    expect(s.served).toBe(N - 1);
  });
});

// ---------------------------------------------------------------------------

describe('Intent Mode (prepay) and legacy header', () => {
  it('prepay attaches the mandate to the FIRST request once an offer for the resource is cached', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    await approved(wallet);
    // no cache yet: prepay falls back to Order Mode (402 first)
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { prepay: true })).status).toBe(200);
    expect(s.requests).toBe(2);
    expect(s.offersSent).toBe(1);
    // cached: one round trip, no 402
    expect((await wallet.fetch(`${s.url}/predict?x=1`, undefined, { prepay: true })).status).toBe(200);
    expect(s.requests).toBe(3);
    expect(s.offersSent).toBe(1);
    expect(s.served).toBe(2);
    // without prepay the wallet still negotiates
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(s.requests).toBe(5);
    expect(s.offersSent).toBe(2);
    // the cache is per method+origin+path: a different resource negotiates again
    const s2 = await serve({ resource: 'POST /analyze' });
    expect((await wallet.fetch(`${s2.url}/analyze`, { method: 'POST' }, { prepay: true })).status).toBe(200);
    expect(s2.offersSent).toBe(1);
  });

  it('caps.legacyHeader sends X-Payment-Mandate with the bare {mandate, payerSig}', async () => {
    const s = await serve({ mode: { legacyOnly: true } });
    const { wallet, ledgerPath } = makeWallet({ caps: { legacyHeader: true } });
    await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(200);
    expect(s.served).toBe(1);
    expect(readLedger(ledgerPath)[0].status).toBe('enqueued');
    // still an ordinary payee accepts it too
    const modern = await serve();
    expect((await wallet.fetch(`${modern.url}/predict`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('report()', () => {
  it('has the documented shape and aggregates mandates, ledger statuses, hosts and resources', async () => {
    const ok = await serve();
    const bad = await serve({ resource: 'POST /analyze', mode: { receipt: 'bad-sig' } });
    const refuse = await serve({ mode: { reject: { status: 402, body: { error: 'insufficient_balance' } } } });
    const t = nowSec();
    const { wallet } = makeWallet({ now: () => t });
    const a = await approved(wallet, { limitAmount: '$0.005', hostAllowlist: ['127.0.0.1'] });
    const b = await approved(wallet, { limitAmount: '$0.002', validForSeconds: 60, hostAllowlist: ['*'] });
    await wallet.fetch(`${ok.url}/predict`); // b expires first -> charged to b
    await wallet.fetch(`${bad.url}/analyze`, { method: 'POST' }); // b again (unknown)
    await wallet.fetch(`${refuse.url}/predict`); // b exhausted -> a, rejected (reserved)
    await expectViolation(wallet.fetch(`${ok.url}/predict`, undefined, { mandateId: 'im_x' }), 'mandate_not_found');

    const r = wallet.report();
    expect(r.address).toBe(wallet.address);
    expect(r.walletContract).toBe(WALLET);
    expect(r.mandates).toEqual([
      {
        id: a.id,
        naturalLanguage: a.naturalLanguage,
        limitAmount: '5000',
        spentAmount: '0',
        pendingSpentAmount: '1000',
        validUntil: a.validUntil,
        isEnabled: true,
        status: 'signed',
        hostAllowlist: ['127.0.0.1'],
        remainingAmount: '4000',
      },
      {
        id: b.id,
        naturalLanguage: b.naturalLanguage,
        limitAmount: '2000',
        spentAmount: '2000',
        pendingSpentAmount: '0',
        validUntil: b.validUntil,
        isEnabled: true,
        status: 'signed',
        hostAllowlist: ['*'],
        remainingAmount: '0',
      },
    ]);
    expect(r.totals).toEqual({
      spent: '2000',
      pending: '1000',
      enqueued: 1,
      settled: 0,
      rejected: 1,
      unknown: 1,
      expiredUnused: 0,
      spDefaults: 0,
    });
    expect(r.byHost).toEqual({ [new URL(ok.url).host]: '1000', [new URL(bad.url).host]: '1000' });
    expect(r.byResource).toEqual({ 'GET /predict': '1000', 'POST /analyze': '1000' });
    expect(r.policyDenials).toEqual([
      { reason: 'mandate_not_found', url: `${ok.url}/predict`, mandateId: 'im_x', timestamp: t },
    ]);
  });
});
