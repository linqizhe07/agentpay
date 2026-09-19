import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hashTypedData, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { PolicyViolation, WireError, type Address, type Hex } from '@agentpay/core';
import {
  INTENT_DOMAIN,
  INTENT_MANDATE_TYPES,
  IntentMandateStore,
  LEDGER_STATUS_HEADER,
  Ledger,
  MandateWallet,
  NONCE_HEADER,
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
const TOKEN = ('0x' + '11'.repeat(20)) as Address;
const PRICE = '$0.001';
const AMOUNT = 1000n;
const MAX_TIMEOUT = 60;
const payerAccount = privateKeyToAccount(KEYS.payer);
const payeeAddress = privateKeyToAccount(KEYS.payee).address;
const facilitatorAddress = privateKeyToAccount(KEYS.facilitator).address;
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
    // offline suite: fetch() never touches the chain, reconcile() must fail fast
    rpcUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: NETWORK,
    mandatesPath,
    ledgerPath,
    transportRetries: { attempts: 2, delayMs: 5 },
    ...over,
  });
  return { wallet, dir, mandatesPath, ledgerPath, account };
}

const servers: StubPayee[] = [];
async function serve(over: Partial<StubPayeeOptions> = {}): Promise<StubPayee> {
  const s = await startStubPayee({
    payTo: payeeAddress,
    token: TOKEN,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: NETWORK,
    price: PRICE,
    maxTimeoutSeconds: MAX_TIMEOUT,
    facilitatorAddress,
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
  expect((err as PolicyViolation).payment_model_context?.protocol).toBe('x402');
  return err as PolicyViolation;
}

const nowSec = () => Math.floor(Date.now() / 1000);

const ledgerEntry = (nonceByte: string, over: Partial<LedgerEntry> = {}): LedgerEntry => {
  const nonce = ('0x' + nonceByte.repeat(32)) as Hex;
  return {
    v: 2,
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
    intentMandateId: 'im_1',
    nonce,
    validBefore: 2,
    authorization: { from: payerAccount.address, to: strangerAddress, value: '5', validAfter: '0', validBefore: '2', nonce },
    signature: '0x' as Hex,
    httpStatus: 200,
    status: 'settled',
    ...over,
  };
};

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
  it('appends, reads back, and patches status by nonce', () => {
    const ledger = new Ledger(join(root, 'ledger-unit', 'ledger.jsonl'));
    const entry = ledgerEntry('ab', { status: 'rejected' });
    expect(ledger.read()).toEqual([]);
    ledger.append(entry);
    ledger.append(ledgerEntry('cd'));
    expect(ledger.read()).toHaveLength(2);
    ledger.updateStatus(entry.nonce, 'settled', { transaction: ('0x' + '01'.repeat(32)) as Hex });
    const [a, b] = ledger.read();
    expect(a.status).toBe('settled');
    expect(a.transaction).toBe('0x' + '01'.repeat(32));
    expect(b.status).toBe('settled');
    expect(() => ledger.updateStatus(('0x' + 'ee'.repeat(32)) as Hex, 'settled')).toThrow(/no ledger entry/);
  });

  it('updateStatus leaves no .tmp behind (the tmp+fsync+rename sequence itself is pinned in ledger-durable.test.ts)', () => {
    const dir = join(root, 'ledger-atomic');
    const ledger = new Ledger(join(dir, 'ledger.jsonl'));
    const entry = ledgerEntry('ab');
    ledger.append(entry);
    ledger.updateStatus(entry.nonce, 'settled');
    ledger.updateStatus(entry.nonce, 'expired-unused');
    expect(readdirSync(dir)).toEqual(['ledger.jsonl']);
    expect(ledger.read().map((e) => e.status)).toEqual(['expired-unused']);
  });

  it('ignores a truncated last line on read; append() drops it and keeps appending cleanly', () => {
    const path = join(root, 'ledger-truncated', 'ledger.jsonl');
    const w = new Ledger(path);
    const a = ledgerEntry('ab');
    w.append(a);
    const torn = '{"v":2,"kind":"payment","nonce":"0x00","status":"sett';
    appendFileSync(path, torn, 'utf8'); // crash mid-append
    const asLeft = readFileSync(path, 'utf8');

    // A plain reader (report(), reconcile(), the constructor's rebuild) sees the
    // complete lines and leaves the file alone: it could be another process's
    // append still in progress.
    const warnings: string[] = [];
    const r = new Ledger(path, (line) => warnings.push(line));
    expect(r.read()).toEqual([a]);
    expect(warnings.join('\n')).toMatch(/ignoring truncated last line/);
    expect(readFileSync(path, 'utf8')).toBe(asLeft);

    // fetch() appends before it ever read: the torn tail must not swallow the new line
    const b = ledgerEntry('cd');
    const repairs: string[] = [];
    new Ledger(path, (line) => repairs.push(line)).append(b);
    expect(repairs.join('\n')).toMatch(/dropped truncated last line/);
    expect(new Ledger(path).read()).toEqual([a, b]);
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(3); // 2 lines + trailing newline

    // updateStatus() rewrites only what parsed, so a torn tail goes away with it
    appendFileSync(path, torn, 'utf8');
    r.updateStatus(a.nonce, 'expired-unused');
    expect(new Ledger(path).read().map((e) => e.status)).toEqual(['expired-unused', 'settled']);
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(3);
  });

  it('keeps a complete but unterminated last line', () => {
    const path = join(root, 'ledger-unterminated', 'ledger.jsonl');
    const a = ledgerEntry('ab');
    new Ledger(path).append(a); // creates the directory
    writeFileSync(path, JSON.stringify(a), 'utf8'); // no trailing newline
    const warnings: string[] = [];
    expect(new Ledger(path, (line) => warnings.push(line)).read()).toEqual([a]);
    expect(warnings).toEqual([]);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(false); // a reader leaves the file alone
    const b = ledgerEntry('cd');
    new Ledger(path).append(b);
    expect(new Ledger(path).read()).toEqual([a, b]);
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(3);
  });

  it('refuses a corrupt line that is not the last one', () => {
    const path = join(root, 'ledger-corrupt', 'ledger.jsonl');
    const a = ledgerEntry('ab');
    new Ledger(path).append(a);
    writeFileSync(path, `${JSON.stringify(a)}\n{"kind":"pay\n${JSON.stringify(ledgerEntry('cd'))}\n`, 'utf8');
    expect(() => new Ledger(path).read()).toThrow(/malformed ledger line 2/);
    expect(() => new Ledger(path).updateStatus(a.nonce, 'settled')).toThrow(/malformed ledger line 2/);
    writeFileSync(path, '42\n', 'utf8');
    expect(() => new Ledger(path).read()).toThrow(/malformed ledger line 1 .*not an object/);
  });

  it('refuses an AEP2-era ledger instead of guessing at its rows', () => {
    const path = join(root, 'ledger-aep2', 'ledger.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    const old = { kind: 'payment', mandateDigest: '0x' + 'ab'.repeat(32), status: 'enqueued', amount: '1000', intentMandateId: 'im_1' };
    writeFileSync(path, `${JSON.stringify(old)}\n`, 'utf8');
    expect(() => new Ledger(path).read()).toThrow(/AEP2-era row \(v1\).*fresh AGENTPAY_HOME/);
    // and the wallet refuses to start on it, so a stale budget is never rebuilt from it
    expect(() => makeWallet({ ledgerPath: path })).toThrow(/AEP2-era/);
    writeFileSync(path, `${JSON.stringify({ ...ledgerEntry('ab'), v: 3 })}\n`, 'utf8');
    expect(() => new Ledger(path).read()).toThrow(/version 3/);
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

  it('refuses a store file written by another version', () => {
    const path = join(root, 'store-version', 'mandates.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, mandates: [] }), 'utf8');
    expect(() => new IntentMandateStore(path)).toThrow(/unsupported mandate store version 2/);
    writeFileSync(path, JSON.stringify({ mandates: [] }), 'utf8'); // no version at all is still version 1
    expect(new IntentMandateStore(path).list()).toEqual([]);
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
    expect(s.payments).toHaveLength(0);

    const signed = await wallet.approveIntentMandate(draft.id);
    expect(signed.status).toBe('signed');
    expect(signed.signedAt).toBeGreaterThan(0);
    expect(await recoverIntentMandateSigner(CHAIN_ID, signed, signed.signature!)).toBe(wallet.address);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n }).eligible.map((m) => m.id)).toEqual([draft.id]);
    expect(wallet.eligibleMandates({ host: '127.0.0.1:8080', amount: 1000n }).eligible).toHaveLength(1);
    expect(wallet.remaining(draft.id)).toBe(2_500_000n);

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
    expect(() => makeWallet({ assetDomain: { name: '', version: '2' } })).toThrow(/assetDomain/);
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
  it('unsupported_offer (no exact offer for this wallet token)', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet({ token: strangerAddress });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'unsupported_offer');
    expect(err.detail?.offered).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(s.payments).toHaveLength(0);
  });

  it('unsupported_offer when the offer names another network or another token domain', async () => {
    const otherNet = await serve({ network: 'eip155:84532' });
    const { wallet, account } = makeWallet();
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    await expectViolation(wallet.fetch(`${otherNet.url}/predict`), 'unsupported_offer');
    const otherDomain = await serve({ assetDomain: { name: 'USDC', version: '2' } });
    await expectViolation(wallet.fetch(`${otherDomain.url}/predict`), 'unsupported_offer');
    expect(spy).not.toHaveBeenCalled();
  });

  it('timeout_too_long when the offer wants an authorization outliving the wallet cap', async () => {
    const s = await serve({ maxTimeoutSeconds: 3600 });
    const { wallet, account } = makeWallet();
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'timeout_too_long');
    expect(err.detail).toEqual({ maxTimeoutSeconds: 3600, cap: 300 });
    expect(spy).not.toHaveBeenCalled();
    const lenient = makeWallet({ caps: { maxAuthorizationValiditySeconds: 3600 } });
    await approved(lenient.wallet);
    expect((await lenient.wallet.fetch(`${s.url}/predict`)).status).toBe(200);
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
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n }).eligible.map((m) => m.id)).toEqual([soon.id, late.id]);
    await wallet.fetch(`${s.url}/predict`);
    expect(wallet.remaining(soon.id)).toBe(999_000n);
    expect(wallet.remaining(late.id)).toBe(1_000_000n);
  });
});

// ---------------------------------------------------------------------------

describe('payment happy path + budget accounting', () => {
  it('pays with a single-use authorization, commits the reservation on the settlement report, writes the ledger', async () => {
    const s = await serve();
    const t = nowSec();
    const { wallet, ledgerPath, mandatesPath } = makeWallet({ now: () => t });
    const m = await approved(wallet, { limitAmount: '$0.01' });

    const res = await wallet.fetch(`${s.url}/predict?symbol=ETH`, { headers: { 'x-trace': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resource: 'GET /predict', served: 1 });
    expect(s.served).toBe(1);
    expect(s.requests).toBe(2); // 402 then paid
    const settlement = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')!);
    expect(settlement.success).toBe(true);
    expect(res.headers.get(NONCE_HEADER)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.headers.get(LEDGER_STATUS_HEADER)).toBe('settled');

    // budget: reservation converted to spend
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
    expect(wallet.remaining(m.id)).toBe(9000n);

    // the payee received an authorization that recovers to the payer under the token domain
    const [payload] = s.payments;
    const { authorization, signature } = payload.payload as { authorization: Record<string, string>; signature: Hex };
    expect(authorization).toMatchObject({ from: wallet.address, to: s.address, value: '1000', validAfter: '0' });
    expect(Number(authorization.validBefore)).toBeGreaterThanOrEqual(nowSec() + MAX_TIMEOUT - 5);
    expect(Number(authorization.validBefore)).toBeLessThanOrEqual(nowSec() + MAX_TIMEOUT + 5);
    expect(
      await verifyTypedData({
        address: wallet.address,
        domain: { ...MOCK_USDC_DOMAIN, chainId: CHAIN_ID, verifyingContract: TOKEN },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from as Address,
          to: authorization.to as Address,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce as Hex,
        },
        signature,
      }),
    ).toBe(true);

    // ledger entry shape
    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e).toMatchObject({
      v: 2,
      kind: 'payment',
      timestamp: t,
      signedAt: t,
      url: `${s.url}/predict?symbol=ETH`,
      host: new URL(s.url).host,
      resource: 'GET /predict',
      network: NETWORK,
      asset: TOKEN,
      amount: '1000',
      payer: wallet.address,
      payee: s.address,
      intentMandateId: m.id,
      nonce: authorization.nonce,
      validBefore: Number(authorization.validBefore),
      authorization,
      signature,
      httpStatus: 200,
      status: 'settled',
      transaction: settlement.transaction,
    });
    expect(e.error).toBeUndefined();
    expect(e.verified).toBeUndefined();

    // a second wallet over the same files sees the same budget and ledger
    const again = new MandateWallet({
      key: KEYS.payer,
      token: TOKEN,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      network: NETWORK,
      mandatesPath,
      ledgerPath,
      now: () => t,
    });
    expect(again.remaining(m.id)).toBe(9000n);
    expect(again.report().totals).toMatchObject({ spent: '1000', pending: '0', settled: 1 });
    await again.fetch(`${s.url}/predict`);
    expect(again.remaining(m.id)).toBe(8000n);
    expect(wallet.report().totals.settled).toBe(2); // ledger is shared…
    expect(new IntentMandateStore(mandatesPath).get(m.id)?.spentAmount).toBe('2000'); // …and so is the store
  });

  it('the request body is re-sent with the payment', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    await approved(wallet);
    const res = await wallet.fetch(`${s.url}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, echo: { text: 'hello' } });
    expect(readLedger(wallet.report().address ? (servers.length ? join(root, `w${n - 1}`, 'ledger.jsonl') : '') : '')[0]?.resource).toBe('POST /analyze');
  });

  it('non-402 responses pass through untouched and cost nothing', async () => {
    const s = await serve();
    const { wallet, account, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const res = await wallet.fetch(`${s.url}/nope`);
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    expect(wallet.remaining(m.id)).toBe(1_000_000n);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('a 402 without a usable PAYMENT-REQUIRED header is a WireError, not a payment', async () => {
    const { wallet, account } = makeWallet({
      fetch: async () => new Response('{"error":"pay me"}', { status: 402, headers: { 'content-type': 'application/json' } }),
    });
    await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    await expect(wallet.fetch('http://127.0.0.1:1/predict')).rejects.toThrow(WireError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a signing failure releases the reservation and rethrows', async () => {
    const s = await serve();
    const { wallet, account, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    vi.spyOn(account, 'signTypedData').mockRejectedValueOnce(new Error('hsm offline'));
    await expect(wallet.fetch(`${s.url}/predict`)).rejects.toThrow(/hsm offline/);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '0' });
    expect(existsSync(ledgerPath)).toBe(false); // nothing was signed, nothing to remember
    expect(s.payments).toHaveLength(0);
  });

  it('signedAt is the signing time and survives the status update; timestamp moves with it', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, ledgerPath } = makeWallet({ now: () => t });
    await approved(wallet);
    const signedAt = t;
    const fetchImpl = globalThis.fetch;
    // the paid retry happens 5 "seconds" after signing
    const w2 = makeWallet({
      now: () => t,
      fetch: async (input, init) => {
        const res = await fetchImpl(input, init);
        if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) t += 5;
        return res;
      },
    });
    await approved(w2.wallet);
    await w2.wallet.fetch(`${s.url}/predict`);
    const [e] = readLedger(w2.ledgerPath);
    expect(e.signedAt).toBe(signedAt);
    expect(e.timestamp).toBe(signedAt + 5);
    void ledgerPath;
  });
});

// ---------------------------------------------------------------------------

describe('settlement report handling', () => {
  for (const [rawMode, error] of [
    ['no-response-header', 'missing PAYMENT-RESPONSE'],
    ['malformed-response', 'malformed PAYMENT-RESPONSE'],
    ['wrong-network', 'settlement not successful'],
    ['success-false', 'settlement not successful: invalid_exact_evm_transaction_failed'],
  ] as const) {
    it(`2xx with ${rawMode} -> ledger 'unknown', budget spent (charged or not is unknowable offline)`, async () => {
      const s = await serve({ rawMode });
      const { wallet, ledgerPath } = makeWallet();
      const m = await approved(wallet);
      const res = await wallet.fetch(`${s.url}/raw`);
      expect(res.status).toBe(200);
      expect(res.headers.get(LEDGER_STATUS_HEADER)).toBe('unknown');
      const [e] = readLedger(ledgerPath);
      expect(e.status).toBe('unknown');
      expect(e.httpStatus).toBe(200);
      expect(e.error).toContain(error.split(':')[0]);
      expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
    });
  }

  it('settlement_pending (broadcast, receipt unknown) -> unknown with the transaction, reservation kept', async () => {
    const s = await serve({ rawMode: 'settlement-pending' });
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/raw`);
    expect(res.status).toBe(402);
    const [e] = readLedger(ledgerPath);
    expect(e).toMatchObject({ status: 'unknown', httpStatus: 402, error: 'settlement_pending', transaction: '0x' + 'ab'.repeat(32) });
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
  });
});

// ---------------------------------------------------------------------------

describe('refusals after signing', () => {
  it('a facilitator refusal -> ledger rejected with the header reason, reservation KEPT, response returned', async () => {
    const s = await serve();
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(402);
    expect(res.headers.get(LEDGER_STATUS_HEADER)).toBe('rejected');
    const [e] = readLedger(ledgerPath);
    expect(e).toMatchObject({ status: 'rejected', httpStatus: 402, error: 'invalid_exact_evm_insufficient_balance' });
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' }); // the authorization is live until validBefore
    expect(wallet.remaining(m.id)).toBe(999_000n);
    expect(s.served).toBe(0);
  });

  it('a settlement that fails after the handler ran -> rejected with the settlement reason', async () => {
    const s = await serve();
    s.mode = { kind: 'settle-fail', reason: 'invalid_exact_evm_transaction_failed' };
    const { wallet, ledgerPath } = makeWallet();
    await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(402);
    expect(readLedger(ledgerPath)[0]).toMatchObject({ status: 'rejected', error: 'invalid_exact_evm_transaction_failed' });
    expect(s.served).toBe(1);
  });

  it('a payee that pays but then fails (5xx after settlement) -> settled, "paid but http 500"', async () => {
    const fetchImpl = globalThis.fetch;
    const s = await serve();
    // The stub payee settles after the handler; emulate a payee that settled and then broke by rewriting the status.
    const { wallet, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        const res = await fetchImpl(input, init);
        if (res.status === 200 && res.headers.has('PAYMENT-RESPONSE')) {
          return new Response(await res.arrayBuffer(), { status: 500, headers: res.headers });
        }
        return res;
      },
    });
    const m = await approved(wallet);
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(500);
    expect(readLedger(ledgerPath)[0]).toMatchObject({ status: 'settled', httpStatus: 500, error: 'paid but http 500' });
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
  });

  it('a transport error on the paid retry re-presents the SAME header; success on the second try is one payment', async () => {
    const fetchImpl = globalThis.fetch;
    const s = await serve();
    let paidAttempts = 0;
    const { wallet, account, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        if (new Headers(init?.headers).has('PAYMENT-SIGNATURE') && ++paidAttempts === 1) throw new TypeError('fetch failed');
        return fetchImpl(input, init);
      },
    });
    const m = await approved(wallet);
    const spy = vi.spyOn(account, 'signTypedData');
    const res = await wallet.fetch(`${s.url}/predict`);
    expect(res.status).toBe(200);
    expect(paidAttempts).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1); // one authorization, presented twice
    expect(s.payments).toHaveLength(1);
    expect(readLedger(ledgerPath)[0].status).toBe('settled');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
  });

  it('a transport error that persists -> ledger unknown (httpStatus 0), reservation kept, error rethrown', async () => {
    const fetchImpl = globalThis.fetch;
    let paidAttempts = 0;
    const { wallet, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) {
          paidAttempts++;
          throw new TypeError('fetch failed');
        }
        return fetchImpl(input, init);
      },
    });
    const s = await serve();
    const m = await approved(wallet);
    await expect(wallet.fetch(`${s.url}/predict`)).rejects.toThrow(/fetch failed/);
    expect(paidAttempts).toBe(3); // 1 + 2 retries
    const [e] = readLedger(ledgerPath);
    expect(e).toMatchObject({ status: 'unknown', httpStatus: 0, error: 'network: fetch failed' });
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
  });

  it('reconcile() needs an RPC, and keeps everything pending when it is unreachable', async () => {
    const s = await serve();
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    const { wallet, ledgerPath } = makeWallet();
    await approved(wallet);
    await wallet.fetch(`${s.url}/predict`);
    const [e] = readLedger(ledgerPath);
    expect(await wallet.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [e.nonce], verified: [] });
    expect(readLedger(ledgerPath)[0].status).toBe('rejected');
    const noRpc = makeWallet({ rpcUrl: undefined, ledgerPath, mandatesPath: join(root, `w${n - 1}`, 'mandates.json') });
    await expect(noRpc.wallet.reconcile()).rejects.toThrow(/rpcUrl is required/);
    await expect(noRpc.wallet.balance()).rejects.toThrow(/rpcUrl is required/);
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
    const denied = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof PolicyViolation);
    expect(ok).toHaveLength(N - 1);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason.reason).toBe('mandate_insufficient_budget');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: String(1000 * (N - 1)), pendingSpentAmount: '0' });
    expect(wallet.remaining(m.id)).toBe(0n);
    expect(s.served).toBe(N - 1);
  });
});

// ---------------------------------------------------------------------------

describe('budget counters are rebuilt from the ledger on load', () => {
  it('A: crash after the spend was committed, before the ledger left in_flight -> X counted once, as pending', async () => {
    const s = await serve();
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
    const [e] = readLedger(ledgerPath);
    new Ledger(ledgerPath).updateStatus(e.nonce, 'unknown', { httpStatus: 0, error: 'in_flight', transaction: undefined });

    const lines: string[] = [];
    const again = makeWallet({ mandatesPath, ledgerPath, log: (l) => lines.push(l) }).wallet;
    expect(again.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
    expect(again.remaining(m.id)).toBe(999_000n);
    expect(lines).toEqual([expect.stringContaining(`${m.id}: counters rebuilt from the ledger (spent 1000 -> 0, pending 0 -> 1000)`)]);
    expect(new IntentMandateStore(mandatesPath).get(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });
    expect(again.report().totals).toMatchObject({ spent: '0', pending: '1000', unknown: 1 });
  });

  it('B: crash after the reservation, before the ledger line -> the phantom reservation is released', async () => {
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const store = new IntentMandateStore(mandatesPath);
    store.upsert({ ...store.get(m.id)!, pendingSpentAmount: '1000' });
    store.save();
    expect(existsSync(ledgerPath)).toBe(false);

    const lines: string[] = [];
    const again = makeWallet({ mandatesPath, ledgerPath, log: (l) => lines.push(l) }).wallet;
    expect(again.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '0' });
    expect(again.remaining(m.id)).toBe(1_000_000n);
    expect(lines).toEqual([expect.stringContaining('pending 1000 -> 0')]);
  });

  it('classifies every status: rejected and in-flight hold the reservation, settled/unknown-2xx are spent, expired-unused is neither', async () => {
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    const l = new Ledger(ledgerPath);
    l.append(ledgerEntry('01', { intentMandateId: m.id, amount: '1', status: 'rejected', httpStatus: 402 }));
    l.append(ledgerEntry('02', { intentMandateId: m.id, amount: '2', status: 'unknown', httpStatus: 0, error: 'in_flight' }));
    l.append(ledgerEntry('03', { intentMandateId: m.id, amount: '4', status: 'settled', httpStatus: 200 }));
    l.append(ledgerEntry('04', { intentMandateId: m.id, amount: '8', status: 'unknown', httpStatus: 200, error: 'missing PAYMENT-RESPONSE' }));
    l.append(ledgerEntry('05', { intentMandateId: m.id, amount: '16', status: 'expired-unused', httpStatus: 402 }));
    l.append(ledgerEntry('06', { intentMandateId: m.id, amount: '32', status: 'unknown', httpStatus: 402, error: 'settlement_pending' }));
    l.append(ledgerEntry('07', { intentMandateId: m.id, amount: '64', status: 'settled', httpStatus: 500, error: 'paid but http 500' }));
    l.append(ledgerEntry('08', { intentMandateId: 'im_gone', amount: '128', status: 'settled', httpStatus: 200 })); // not in the store: ignored
    const again = makeWallet({ mandatesPath, ledgerPath }).wallet;
    expect(again.getMandate(m.id)).toMatchObject({ pendingSpentAmount: '35', spentAmount: '76' });
    expect(again.listMandates().map((x) => x.id)).toEqual([m.id]);
    expect(again.report().totals).toMatchObject({ settled: 3, rejected: 1, unknown: 3, expiredUnused: 1 });
  });

  it('counters that already agree are left alone: nothing logged, nothing rewritten', async () => {
    const s = await serve();
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const m = await approved(wallet);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    const file = readFileSync(mandatesPath, 'utf8');
    const lines: string[] = [];
    const again = makeWallet({ mandatesPath, ledgerPath, log: (l) => lines.push(l) }).wallet;
    expect(lines).toEqual([]);
    expect(readFileSync(mandatesPath, 'utf8')).toBe(file);
    expect(again.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
  });
});

// ---------------------------------------------------------------------------

describe('Intent Mode (prepay)', () => {
  it('prepay attaches the payment to the FIRST request once an offer for the resource is cached', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    await approved(wallet);
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { prepay: true })).status).toBe(200);
    expect(s.requests).toBe(2); // nothing cached yet: 402 first
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { prepay: true })).status).toBe(200);
    expect(s.requests).toBe(3); // paid on the first request
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(s.requests).toBe(5); // without prepay: 402 first again
    expect(s.served).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('report()', () => {
  it('has the documented shape and aggregates mandates, ledger statuses, hosts and resources', async () => {
    const s = await serve();
    const { wallet, ledgerPath } = makeWallet();
    const m = await approved(wallet, { limitAmount: '$0.01' });
    await wallet.fetch(`${s.url}/predict`);
    await wallet.fetch(`${s.url}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    await wallet.fetch(`${s.url}/predict`);
    const r = wallet.report();
    expect(r).toMatchObject({ address: wallet.address, token: TOKEN, network: NETWORK });
    expect(r.mandates).toEqual([
      expect.objectContaining({ id: m.id, limitAmount: '10000', spentAmount: '2000', pendingSpentAmount: '1000', remainingAmount: '7000', status: 'signed', isEnabled: true, hostAllowlist: ['127.0.0.1'] }),
    ]);
    expect(r.totals).toEqual({ spent: '2000', pending: '1000', settled: 2, rejected: 1, unknown: 0, expiredUnused: 0 });
    expect(r.byHost).toEqual({ [new URL(s.url).host]: '2000' });
    expect(r.byResource).toEqual({ 'GET /predict': '1000', 'POST /analyze': '1000' });
    expect(r.policyDenials).toEqual([]);
    expect(readLedger(ledgerPath)).toHaveLength(3);
  });
});
