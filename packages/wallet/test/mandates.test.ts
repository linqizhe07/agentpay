/**
 * Delegated budgets and the agent surface around them: holders and callers,
 * chain accounting, the lock, signature verification, payment context and
 * reconcile() beside a live fetch(). Offline like wallet.test.ts (the stub
 * payee, no chain; reconcile() runs over a stubbed public client).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient } from 'viem';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { PolicyViolation, type Address, type Hex } from '@agentpay/core';
import {
  IntentMandateStore,
  LOCK_FILE,
  Ledger,
  MAX_DELEGATED_VALIDITY_SECONDS,
  MandateWallet,
  holderSetFor,
  intentMandateHash,
  isHolder,
  lockedBy,
  parseHolder,
  recoverIntentMandateSigner,
  validatePaymentContext,
  type Caller,
  type IntentMandate,
  type IntentMandateInput,
  type LedgerEntry,
  type MandateWalletOptions,
} from '../src/index.js';
import { KEYS, startStubPayee, type StubPayee, type StubPayeeOptions } from './stub-payee.js';

const NETWORK = 'eip155:31337';
const CHAIN_ID = 31337;
const TOKEN = ('0x' + '11'.repeat(20)) as Address;
const PRICE = '$0.001';
const MAX_TIMEOUT = 60;
const payerAccount = privateKeyToAccount(KEYS.payer);
const payeeAddress = privateKeyToAccount(KEYS.payee).address;
const facilitatorAddress = privateKeyToAccount(KEYS.facilitator).address;

const root = mkdtempSync(join(tmpdir(), 'agentpay-mandates-test-'));
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
    rpcUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: NETWORK,
    mandatesPath,
    ledgerPath,
    transportRetries: { attempts: 2, delayMs: 5 },
    ...over,
  });
  return { wallet, dir, mandatesPath: over.mandatesPath ?? mandatesPath, ledgerPath: over.ledgerPath ?? ledgerPath, account };
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

const childInput = (over: Partial<IntentMandateInput> = {}): IntentMandateInput => ({
  naturalLanguage: 'a sub-budget',
  limitAmount: '2500',
  validForSeconds: 600,
  hostAllowlist: ['127.0.0.1'],
  ...over,
});

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
  return err as PolicyViolation;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const counters = (m: IntentMandate | undefined) => ({ spent: m?.spentAmount, pending: m?.pendingSpentAmount });

const SESSION_G: Caller = { kind: 'session', id: 'g' };
const SESSION_C: Caller = { kind: 'session', id: 'c' };

/** A signed-looking mandate written straight into a store (what a hand edit produces; the gate never verifies signatures). */
function handMade(over: Partial<IntentMandate> & Pick<IntentMandate, 'id'>): IntentMandate {
  const t = nowSec();
  return {
    naturalLanguage: 'hand made',
    currency: 'USDC',
    limitAmount: '1000000',
    hostAllowlist: ['127.0.0.1'],
    validFrom: t - 10,
    validUntil: t + 3600,
    spentAmount: '0',
    pendingSpentAmount: '0',
    status: 'signed',
    isEnabled: true,
    mandateHash: '0x' as Hex,
    signature: ('0x' + 'ab'.repeat(65)) as Hex,
    createdAt: t - 10,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('holder grammar', () => {
  it('parses the three holder kinds and nothing else', () => {
    expect(parseHolder('session:abc')).toEqual({ kind: 'session', id: 'abc' });
    expect(parseHolder('children:p 1')).toBeUndefined();
    expect(parseHolder('children:p1')).toEqual({ kind: 'children', id: 'p1' });
    expect(parseHolder('bot:kairos')).toEqual({ kind: 'bot', id: 'kairos' });
    for (const bad of ['', 'session:', 'nobody', 'principal', 'Session:x', 'session: x', ' session:x']) {
      expect(isHolder(bad), bad).toBe(false);
    }
    expect(isHolder('session:x:y')).toBe(true); // ids may carry colons
    expect(isHolder(undefined)).toBe(false);
    expect(isHolder(42)).toBe(false);
  });

  it("holderSetFor: principal = '' (unheld); child = children:<parent> + session:<self>; session and bot by id", () => {
    expect([...holderSetFor({ kind: 'principal' })]).toEqual(['']);
    expect([...holderSetFor({ kind: 'child', id: 's2', parentSession: 'p1' })].sort()).toEqual(['children:p1', 'session:s2']);
    expect([...holderSetFor({ kind: 'child', parentSession: 'p1' })]).toEqual(['children:p1']);
    expect([...holderSetFor({ kind: 'child' })]).toEqual([]);
    expect([...holderSetFor({ kind: 'session', id: 's9' })]).toEqual(['session:s9']);
    expect([...holderSetFor({ kind: 'bot', id: 'b' })]).toEqual(['bot:b']);
    expect([...holderSetFor({ kind: 'bot' })]).toEqual([]);
    expect(() => holderSetFor({ kind: 'operator' } as unknown as Caller)).toThrow(TypeError);
    expect(() => holderSetFor(undefined as unknown as Caller)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe('delegation', () => {
  it('createIntentMandate refuses parentId/holder: a child is only ever delegated', async () => {
    const { wallet } = makeWallet();
    const parent = await approved(wallet);
    await expect(wallet.createIntentMandate(baseInput({ parentId: parent.id })), 'parentId').rejects.toThrow(/use delegateIntentMandate/);
    await expect(wallet.createIntentMandate(baseInput({ holder: 'session:s1' })), 'holder').rejects.toThrow(TypeError);
    expect(wallet.listMandates()).toHaveLength(1);
  });

  it('a delegated mandate is signed in one step, bounded by its parent, and inherits per-call cap and category', async () => {
    const t = nowSec();
    const { wallet, mandatesPath } = makeWallet({ now: () => t });
    const parent = await approved(wallet, { perCallMax: '$0.01', category: 'data', hostAllowlist: ['127.0.0.1', '*.example.com'] });
    const child = await wallet.delegateIntentMandate(
      parent.id,
      childInput({ limitAmount: '$0.5', hostAllowlist: ['127.0.0.1', 'a.example.com', '127.0.0.1:8080'] }),
      'session:s1',
    );
    expect(child).toMatchObject({
      parentId: parent.id,
      holder: 'session:s1',
      status: 'signed',
      limitAmount: '500000',
      perCallMax: '10000',
      category: 'data',
      validFrom: t,
      validUntil: t + 600,
      hostAllowlist: ['127.0.0.1', 'a.example.com', '127.0.0.1:8080'],
      spentAmount: '0',
      pendingSpentAmount: '0',
      isEnabled: true,
      signedAt: t,
    });
    expect(child.id).toMatch(/^im_[0-9a-f]{12}$/);
    // both delegation fields are in the signed struct
    expect(child.mandateHash).toBe(intentMandateHash(CHAIN_ID, child));
    expect(child.mandateHash).not.toBe(intentMandateHash(CHAIN_ID, { ...child, holder: undefined }));
    expect(child.mandateHash).not.toBe(intentMandateHash(CHAIN_ID, { ...child, parentId: undefined }));
    expect(await recoverIntentMandateSigner(CHAIN_ID, child, child.signature!)).toBe(wallet.address);
    expect(new IntentMandateStore(mandatesPath).get(child.id)).toEqual(child);
    expect(wallet.remaining(child.id)).toBe(500_000n);
    expect(wallet.chainOf(child.id).map((m) => m.id)).toEqual([child.id, parent.id]);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n, caller: { kind: 'session', id: 's1' } }).eligible.map((m) => m.id)).toEqual([child.id]);
    expect(await wallet.verifyMandates()).toEqual([]);

    // the child's own overrides win when tighter; a parent without a cap leaves the child free to set one
    const tighter = await wallet.delegateIntentMandate(parent.id, childInput({ perCallMax: '5', category: 'other' }), 'session:s2');
    expect(tighter).toMatchObject({ perCallMax: '5', category: 'other' });
    const clamped = await wallet.delegateIntentMandate(parent.id, childInput({ limitAmount: '5000' }), 'session:s3');
    expect(clamped.perCallMax).toBe('5000'); // inherited $0.01 clamped to the child's own limit
    const uncapped = await approved(wallet);
    expect((await wallet.delegateIntentMandate(uncapped.id, childInput({ perCallMax: '2000' }), 'session:s4')).perCallMax).toBe('2000');
    expect((await wallet.delegateIntentMandate(uncapped.id, childInput(), 'session:s5')).perCallMax).toBeUndefined();
  });

  it('every bound is its own error: holder, parent state, limit, validity, hosts, per-call', async () => {
    let t = nowSec();
    const { wallet } = makeWallet({ now: () => t });
    const parent = await approved(wallet, { perCallMax: '$0.01', validForSeconds: 7 * 86_400 });
    const delegate = (input: Partial<IntentMandateInput>, holder = 'session:s1', parentId = parent.id) =>
      wallet.delegateIntentMandate(parentId, childInput(input), holder);

    await expect(delegate({}, 'nobody')).rejects.toThrow(TypeError);
    await expect(delegate({}, 'session:')).rejects.toThrow(/holder must be/);
    await expect(delegate({ parentId: parent.id })).rejects.toThrow(/not in the input/);
    await expect(delegate({ holder: 'session:s1' })).rejects.toThrow(TypeError);
    await expect(delegate({}, 'session:s1', 'im_missing')).rejects.toThrow(/no intent mandate im_missing/);

    const draft = await wallet.createIntentMandate(baseInput());
    await expect(delegate({}, 'session:s1', draft.id)).rejects.toThrow(/not signed/);
    const disabled = await approved(wallet);
    wallet.setEnabled(disabled.id, false);
    await expect(delegate({}, 'session:s1', disabled.id)).rejects.toThrow(/is disabled/);
    const short = await approved(wallet, { validForSeconds: 100 });
    t += 100;
    await expect(delegate({}, 'session:s1', short.id)).rejects.toThrow(/outside its validity window/);
    t -= 100;

    await expect(delegate({ limitAmount: '1000001' })).rejects.toThrow(RangeError);
    await expect(delegate({ limitAmount: '$1.01' })).rejects.toThrow(/exceeds the parent's effective remaining budget 1000000/);
    expect((await delegate({ limitAmount: '$1' }, 'session:whole')).limitAmount).toBe('1000000'); // equal is fine: a cap, not a reservation

    await expect(delegate({ validForSeconds: MAX_DELEGATED_VALIDITY_SECONDS + 1 })).rejects.toThrow(/exceeds 86400/);
    expect((await delegate({ validForSeconds: MAX_DELEGATED_VALIDITY_SECONDS }, 'session:day')).validUntil).toBe(t + 86_400);
    await expect(delegate({ validForSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(delegate({ validForSeconds: 1.5 })).rejects.toThrow(RangeError);
    // a parent with less than a day left bounds the child to what it has
    const ending = await approved(wallet, { validForSeconds: 100 });
    await expect(delegate({ validForSeconds: 101 }, 'session:s1', ending.id)).rejects.toThrow(/exceeds 100: a delegated budget ends with its parent/);
    expect((await delegate({ validForSeconds: 100 }, 'session:s1', ending.id)).validUntil).toBe(ending.validUntil);

    await expect(delegate({ hostAllowlist: ['api.example.com'] })).rejects.toThrow(/"api.example.com" is not within the parent's allowlist \[127.0.0.1\]/);
    await expect(delegate({ hostAllowlist: ['127.0.0.1', '*'] })).rejects.toThrow(RangeError);
    await expect(delegate({ hostAllowlist: [] })).rejects.toThrow(TypeError); // buildIntentMandate's rule still applies
    expect((await delegate({ hostAllowlist: ['127.0.0.1:8080'] }, 'session:port')).hostAllowlist).toEqual(['127.0.0.1:8080']);

    await expect(delegate({ perCallMax: '10001' })).rejects.toThrow(/perCallMax 10001 exceeds the parent's 10000/);
    await expect(delegate({ perCallMax: '$5' })).rejects.toThrow(RangeError);
    await expect(delegate({ limitAmount: 'abc' })).rejects.toThrow(/unparseable price/);

    // a grandchild is bounded by the child, which is bounded by the root
    const child = await delegate({ limitAmount: '2500' }, 'session:c');
    await expect(wallet.delegateIntentMandate(child.id, childInput({ limitAmount: '2501' }), 'session:g')).rejects.toThrow(RangeError);
    await expect(wallet.delegateIntentMandate(child.id, childInput({ validForSeconds: 601 }), 'session:g')).rejects.toThrow(/exceeds 600/);
    const grandchild = await wallet.delegateIntentMandate(child.id, childInput({ limitAmount: '2500' }), 'session:g');
    expect(wallet.chainOf(grandchild.id).map((m) => m.id)).toEqual([grandchild.id, child.id, parent.id]);
  });

  it('a signing failure leaves no draft behind', async () => {
    const { wallet, account } = makeWallet();
    const parent = await approved(wallet);
    vi.spyOn(account, 'signTypedData').mockRejectedValueOnce(new Error('hsm offline'));
    await expect(wallet.delegateIntentMandate(parent.id, childInput(), 'session:s1')).rejects.toThrow(/hsm offline/);
    expect(wallet.listMandates().map((m) => m.id)).toEqual([parent.id]);
  });
});

// ---------------------------------------------------------------------------

describe('chain accounting', () => {
  it('a payment on a grandchild moves all three counters; totals equal the ledger; remaining is the tightest ancestor', async () => {
    const s = await serve();
    const { wallet, ledgerPath, mandatesPath } = makeWallet();
    const rootM = await approved(wallet);
    const child = await wallet.delegateIntentMandate(rootM.id, childInput({ limitAmount: '2500' }), 'session:c');
    const grandchild = await wallet.delegateIntentMandate(child.id, childInput({ limitAmount: '2500' }), 'session:g');

    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_G })).status).toBe(200);
    expect(readLedger(ledgerPath).map((e) => e.intentMandateId)).toEqual([grandchild.id]);
    for (const m of [rootM, child, grandchild]) expect(counters(wallet.getMandate(m.id)), m.id).toEqual({ spent: '1000', pending: '0' });

    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C })).status).toBe(200);
    expect(counters(wallet.getMandate(rootM.id))).toEqual({ spent: '2000', pending: '0' });
    expect(counters(wallet.getMandate(child.id))).toEqual({ spent: '2000', pending: '0' });
    expect(counters(wallet.getMandate(grandchild.id))).toEqual({ spent: '1000', pending: '0' });
    // the store on disk agrees for every member (one save per booking)
    const disk = new IntentMandateStore(mandatesPath);
    expect(disk.get(child.id)?.spentAmount).toBe('2000');
    expect(disk.get(grandchild.id)?.spentAmount).toBe('1000');

    // effective remaining: the grandchild's own counters say 1500, its parent says 500
    expect(wallet.effectiveRemaining(grandchild.id)).toBe(500n);
    expect(wallet.remaining(grandchild.id)).toBe(500n);
    expect(wallet.remaining(child.id)).toBe(500n);
    expect(wallet.remaining(rootM.id)).toBe(998_000n);
    expect(wallet.effectiveRemaining('im_nope')).toBe(0n);
    expect(() => wallet.remaining('im_nope')).toThrow(/no intent mandate/);

    const r = wallet.report();
    expect(r.totals).toMatchObject({ spent: '2000', pending: '0', settled: 2 }); // roots only == the ledger
    expect(readLedger(ledgerPath).reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(2000n);
    expect(r.mandates.find((m) => m.id === grandchild.id)).toMatchObject({
      parentId: child.id,
      holder: 'session:g',
      spentAmount: '1000',
      remainingAmount: '500',
    });
    expect(r.mandates.find((m) => m.id === rootM.id)).not.toHaveProperty('parentId');
    expect(r.mandates.find((m) => m.id === rootM.id)).not.toHaveProperty('holder');

    // the grandchild cannot pay what its own limit allows but its parent no longer has
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_G }), 'mandate_insufficient_budget');
    expect(err.detail).toMatchObject({ mandateId: grandchild.id, ancestorId: child.id, remaining: '500', amount: '1000' });
    expect(err.payment_model_context?.summary).toContain(`ancestor mandate ${child.id}`);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 1000n, caller: SESSION_G }).rejected).toEqual([
      { id: grandchild.id, reason: 'mandate_insufficient_budget', detail: expect.objectContaining({ ancestorId: child.id }) },
    ]);
    expect(wallet.eligibleMandates({ host: '127.0.0.1', amount: 500n, caller: SESSION_G }).eligible.map((m) => m.id)).toEqual([grandchild.id]);
    expect(s.served).toBe(2);
  });

  it('a reservation is held, converted and released on every chain member', async () => {
    const s = await serve();
    const { wallet, account } = makeWallet();
    const rootM = await approved(wallet);
    const child = await wallet.delegateIntentMandate(rootM.id, childInput(), 'session:c');
    // signing failure: released everywhere
    vi.spyOn(account, 'signTypedData').mockRejectedValueOnce(new Error('hsm offline'));
    await expect(wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C })).rejects.toThrow(/hsm offline/);
    for (const m of [rootM, child]) expect(counters(wallet.getMandate(m.id))).toEqual({ spent: '0', pending: '0' });
    // a refusal after signing: held everywhere
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C })).status).toBe(402);
    for (const m of [rootM, child]) expect(counters(wallet.getMandate(m.id))).toEqual({ spent: '0', pending: '1000' });
    expect(wallet.report().totals).toMatchObject({ spent: '0', pending: '1000' });
  });

  it('rebuilds every member from the ledger; a broken chain is cut where it breaks and logged once', async () => {
    const s = await serve();
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const rootM = await approved(wallet);
    const child = await wallet.delegateIntentMandate(rootM.id, childInput(), 'session:c');
    const grandchild = await wallet.delegateIntentMandate(child.id, childInput({ limitAmount: '2000' }), 'session:g');
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_G })).status).toBe(200);
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C })).status).toBe(402);

    // zero every counter on disk (a store restored from an old copy)
    const store = new IntentMandateStore(mandatesPath);
    for (const m of store.list()) store.upsert({ ...m, spentAmount: '0', pendingSpentAmount: '0' });
    store.save();
    const lines: string[] = [];
    const again = makeWallet({ mandatesPath, ledgerPath, log: (l) => lines.push(l) }).wallet;
    expect(counters(again.getMandate(rootM.id))).toEqual({ spent: '1000', pending: '1000' });
    expect(counters(again.getMandate(child.id))).toEqual({ spent: '1000', pending: '1000' });
    expect(counters(again.getMandate(grandchild.id))).toEqual({ spent: '1000', pending: '0' });
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain(`${rootM.id}: counters rebuilt from the ledger (spent 0 -> 1000, pending 0 -> 1000)`);
    expect(again.report().totals).toMatchObject({ spent: '1000', pending: '1000', settled: 1, rejected: 1 });

    // the child's parent goes missing: the grandchild's chain stops at the child, the root is no longer charged
    store.upsert({ ...store.get(child.id)!, parentId: 'im_gone' });
    store.save();
    const cut: string[] = [];
    const broken = makeWallet({ mandatesPath, ledgerPath, log: (l) => cut.push(l) }).wallet;
    expect(broken.chainOf(grandchild.id).map((m) => m.id)).toEqual([grandchild.id, child.id]);
    expect(broken.chainOf(child.id).map((m) => m.id)).toEqual([child.id]);
    expect(counters(broken.getMandate(rootM.id))).toEqual({ spent: '0', pending: '0' });
    expect(counters(broken.getMandate(child.id))).toEqual({ spent: '1000', pending: '1000' });
    expect(cut.filter((l) => l.includes('im_gone is missing from the store'))).toHaveLength(1); // once, however many rows and walks
    // a cycle stops the same way
    store.upsert({ ...store.get(child.id)!, parentId: grandchild.id });
    store.save();
    const cyc: string[] = [];
    const cyclic = makeWallet({ mandatesPath, ledgerPath, log: (l) => cyc.push(l) }).wallet;
    expect(cyclic.chainOf(grandchild.id).map((m) => m.id)).toEqual([grandchild.id, child.id]);
    expect(cyclic.chainOf(child.id).map((m) => m.id)).toEqual([child.id, grandchild.id]);
    expect(cyc.filter((l) => l.includes('closes a cycle'))).toHaveLength(2); // one per mandate whose parent closes it
  });

  it('the rate window is shared along the chain: a parent limit of 2 over two children refuses the third call', async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, account } = makeWallet({ now: () => t });
    const parent = await approved(wallet, { maxCallsPerMinute: 2 });
    await wallet.delegateIntentMandate(parent.id, childInput({ limitAmount: '$0.5' }), 'children:p1'); // one budget, shared by the siblings
    const a: Caller = { kind: 'child', id: 'a', parentSession: 'p1' };
    const b: Caller = { kind: 'child', id: 'b', parentSession: 'p1' };
    const spy = vi.spyOn(account, 'signTypedData');
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: a })).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: b })).status).toBe(200);
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: a }), 'rate_limited');
    expect(err.detail).toMatchObject({ ancestorId: parent.id, maxCallsPerMinute: 2, attemptsInWindow: 2 });
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'rate_limited'); // the principal on the parent itself, too
    expect(spy).toHaveBeenCalledTimes(2);
    t += 61;
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: b })).status).toBe(200);
  });

  it("an ancestor failing its policy surfaces the ancestor's reason with ancestorId; a hand-widened child cannot escape its root's hosts", async () => {
    const s = await serve();
    let t = nowSec();
    const { wallet, mandatesPath, ledgerPath, account } = makeWallet({ now: () => t });
    const rootM = await approved(wallet, { validForSeconds: 1000 });
    const child = await wallet.delegateIntentMandate(rootM.id, childInput(), 'session:c');
    const spy = vi.spyOn(account, 'signTypedData');

    wallet.setEnabled(rootM.id, false);
    const disabled = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C }), 'mandate_disabled');
    expect(disabled.detail).toEqual({ mandateId: child.id, ancestorId: rootM.id });
    expect(disabled.payment_model_context?.summary).toMatch(/disabled.*on ancestor mandate/);
    // explicit id: the same
    const explicit = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C, mandateId: child.id }), 'mandate_disabled');
    expect(explicit.detail?.ancestorId).toBe(rootM.id);
    wallet.setEnabled(rootM.id, true);
    t += 700; // the child (600 s) expired first: its own reason, no ancestorId
    const own = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: SESSION_C }), 'mandate_expired');
    expect(own.detail?.ancestorId).toBeUndefined();
    t -= 700;
    expect(spy).not.toHaveBeenCalled();
    expect(wallet.report().policyDenials.map((d) => [d.reason, d.mandateId])).toEqual([
      ['mandate_disabled', child.id],
      ['mandate_disabled', child.id],
      ['mandate_expired', child.id],
    ]);

    // a child written by hand under a root that names another host: the root's allowlist still holds
    const store = new IntentMandateStore(mandatesPath);
    const strict = handMade({ id: 'im_strict', hostAllowlist: ['api.example.com'] });
    const wide = handMade({ id: 'im_wide', parentId: strict.id, holder: 'session:w', hostAllowlist: ['*'] });
    store.upsert(strict);
    store.upsert(wide);
    store.save();
    const again = makeWallet({ mandatesPath, ledgerPath, now: () => t }).wallet;
    const w: Caller = { kind: 'session', id: 'w' };
    const host = await expectViolation(again.fetch(`${s.url}/predict`, undefined, { caller: w }), 'host_not_allowed');
    expect(host.detail).toMatchObject({ mandateId: wide.id, ancestorId: strict.id, hostAllowlist: ['api.example.com'] });
    expect(again.eligibleMandates({ host: '127.0.0.1', amount: 1n, caller: w }).rejected[0]).toMatchObject({ id: wide.id, reason: 'host_not_allowed' });
    expect(s.served).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('holders and callers', () => {
  async function fixture() {
    const made = makeWallet();
    const { wallet } = made;
    const unheld = await approved(wallet);
    const forChildren = await wallet.delegateIntentMandate(unheld.id, childInput(), 'children:p1');
    const forS2 = await wallet.delegateIntentMandate(unheld.id, childInput(), 'session:s2');
    const forS9 = await wallet.delegateIntentMandate(unheld.id, childInput(), 'session:s9');
    const forBot = await wallet.delegateIntentMandate(unheld.id, childInput(), 'bot:kairos');
    return { ...made, unheld, forChildren, forS2, forS9, forBot };
  }
  const ids = (r: { eligible: IntentMandate[] }) => r.eligible.map((m) => m.id);

  it('principal sees unheld only; child sees children:<parent> + session:<self>; session and bot see their own', async () => {
    const s = await serve();
    const { wallet, unheld, forChildren, forS2, forS9, forBot, ledgerPath } = await fixture();
    const q = { host: '127.0.0.1', amount: 1000n };
    expect(ids(wallet.eligibleMandates(q))).toEqual([unheld.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'principal' } }))).toEqual([unheld.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'child', id: 's2', parentSession: 'p1' } }))).toEqual([forChildren.id, forS2.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'child', id: 's3', parentSession: 'p1' } }))).toEqual([forChildren.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'child', id: 's2', parentSession: 'p2' } }))).toEqual([forS2.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'session', id: 's9' } }))).toEqual([forS9.id]);
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'session', id: 'p1' } }))).toEqual([]); // the parent does not hold its children's budget
    expect(ids(wallet.eligibleMandates({ ...q, caller: { kind: 'bot', id: 'kairos' } }))).toEqual([forBot.id]);
    expect(wallet.eligibleMandates({ ...q, caller: { kind: 'bot', id: 'other' } })).toEqual({ eligible: [], rejected: [] }); // foreign mandates are not even listed

    // a child pays from the children budget (created first, same validity); the unheld root is charged as its ancestor
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'child', id: 's2', parentSession: 'p1' } })).status).toBe(200);
    expect(readLedger(ledgerPath)[0].intentMandateId).toBe(forChildren.id);
    expect(counters(wallet.getMandate(forChildren.id))).toEqual({ spent: '1000', pending: '0' });
    expect(counters(wallet.getMandate(forS2.id))).toEqual({ spent: '0', pending: '0' });
    expect(counters(wallet.getMandate(unheld.id))).toEqual({ spent: '1000', pending: '0' });
    // the principal never spends a delegated budget
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(readLedger(ledgerPath)[1].intentMandateId).toBe(unheld.id);
    expect(counters(wallet.getMandate(unheld.id))).toEqual({ spent: '2000', pending: '0' });
    expect(counters(wallet.getMandate(forChildren.id))).toEqual({ spent: '1000', pending: '0' });
  });

  it('an empty holder set is no_held_mandate (with its hint); an explicit foreign id is holder_mismatch; an empty store stays mandate_required for the principal', async () => {
    const s = await serve();
    const { wallet, unheld, forChildren, account } = await fixture();
    const spy = vi.spyOn(account, 'signTypedData');
    const bot = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'bot', id: 'b' } }), 'no_held_mandate');
    expect(bot.detail).toEqual({ caller: 'bot b', host: new URL(s.url).host, amount: '1000' });
    expect(bot.payment_model_context?.summary).toContain('bot b');
    expect(bot.payment_model_context?.remediation.join('\n')).toMatch(/delegate/);
    expect(bot.payment_model_context?.commands).toContain('agentpay mandate-delegate --parent <id> --holder <holder> --limit <usd>');
    const orphan = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'child', id: 'x', parentSession: 'p7' } }), 'no_held_mandate');
    expect(orphan.detail?.caller).toBe('child x of p7');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'child' } }), 'no_held_mandate');

    const mismatch = await expectViolation(
      wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'child', id: 's2', parentSession: 'p1' }, mandateId: unheld.id }),
      'holder_mismatch',
    );
    expect(mismatch.detail).toEqual({ mandateId: unheld.id, holder: undefined, caller: 'child s2 of p1' });
    expect(mismatch.payment_model_context?.summary).toContain('held by the principal');
    const principal = await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: forChildren.id }), 'holder_mismatch');
    expect(principal.detail).toEqual({ mandateId: forChildren.id, holder: 'children:p1', caller: 'principal' });
    expect(principal.payment_model_context?.summary).toContain('held by children:p1');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: 'im_missing' }), 'mandate_not_found');
    expect(spy).not.toHaveBeenCalled();
    expect(wallet.report().policyDenials.map((d) => d.reason)).toEqual([
      'no_held_mandate',
      'no_held_mandate',
      'no_held_mandate',
      'holder_mismatch',
      'holder_mismatch',
      'mandate_not_found',
    ]);

    // nothing in the store at all: the principal is told to request one, everyone else that nothing is held for them
    const empty = makeWallet().wallet;
    await expectViolation(empty.fetch(`${s.url}/predict`), 'mandate_required');
    await expectViolation(empty.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'session', id: 'x' } }), 'no_held_mandate');
    // a principal whose only mandates are held by others
    const heldOnly = makeWallet();
    const r = await approved(heldOnly.wallet);
    await heldOnly.wallet.delegateIntentMandate(r.id, childInput(), 'session:s1');
    const store = new IntentMandateStore(heldOnly.mandatesPath);
    store.upsert({ ...store.get(r.id)!, holder: 'bot:b' }); // hand-moved: the root now belongs to a bot
    store.save();
    const w = makeWallet({ mandatesPath: heldOnly.mandatesPath, ledgerPath: heldOnly.ledgerPath }).wallet;
    await expectViolation(w.fetch(`${s.url}/predict`), 'no_held_mandate');
    expect(s.requests).toBe(9); // every refusal above came after the 402, none before
  });

  it('a malformed caller is a TypeError before any request', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    await approved(wallet);
    await expect(wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'operator' } as unknown as Caller })).rejects.toThrow(TypeError);
    expect(s.requests).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('payment context', () => {
  it('validates the context, stores it on the ledger row, and report() groups spend by channel and session', async () => {
    const s = await serve();
    const { wallet, ledgerPath } = makeWallet();
    await approved(wallet);
    const context = { channel: 'ws1', channelName: 'aapl-momentum', session: 's1', parentSession: 'p0', origin: 'subagent', callId: 'c1', label: 'predict' };
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { context })).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { context: { channel: 'ws1', session: 's2', label: undefined } })).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { context: {} })).status).toBe(200);
    s.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { context: { channel: 'ws2', session: 's3' } })).status).toBe(402);

    const rows = readLedger(ledgerPath);
    expect(rows[0].context).toEqual(context);
    expect(rows[1]).not.toHaveProperty('context');
    expect(rows[2].context).toEqual({ channel: 'ws1', session: 's2' });
    expect(rows[3]).not.toHaveProperty('context');
    expect(rows[4]).toMatchObject({ status: 'rejected', context: { channel: 'ws2', session: 's3' } });
    // survives a status patch
    new Ledger(ledgerPath).updateStatus(rows[0].nonce, 'settled', { verified: true });
    expect(readLedger(ledgerPath)[0].context).toEqual(context);

    const r = wallet.report();
    expect(r.byChannel).toEqual({ ws1: '2000', '': '2000' }); // the rejected ws2 row is not spend
    expect(r.bySession).toEqual({ s1: '1000', s2: '1000', '': '2000' });
    expect(r.byHost).toEqual({ [new URL(s.url).host]: '4000' });
    expect(r.totals).toMatchObject({ spent: '4000', pending: '1000' });
  });

  it('refuses anything but bounded strings under the known keys, before any request', async () => {
    const s = await serve();
    const { wallet } = makeWallet();
    await approved(wallet);
    const bad: unknown[] = [
      { channel: 5 },
      { channel: null },
      { foo: 'x' },
      { label: 'x'.repeat(257) },
      'ws1',
      ['ws1'],
      { session: { id: 's1' } },
    ];
    for (const context of bad) {
      await expect(wallet.fetch(`${s.url}/predict`, undefined, { context: context as never }), JSON.stringify(context)).rejects.toThrow(TypeError);
    }
    expect(s.requests).toBe(0);
    expect(validatePaymentContext(undefined)).toBeUndefined();
    expect(validatePaymentContext({})).toBeUndefined();
    expect(validatePaymentContext({ label: 'x'.repeat(256), callId: undefined })).toEqual({ label: 'x'.repeat(256) });
    expect(() => validatePaymentContext({ foo: 'x' })).toThrow(/context.foo is not a known field/);
  });
});

// ---------------------------------------------------------------------------

describe('requireMandateHost', () => {
  it("refuses before the first request unless a mandate in the caller's set names the host", async () => {
    const s = await serve();
    const { wallet, account } = makeWallet({ requireMandateHost: true });
    await expectViolation(wallet.fetch(`${s.url}/predict`), 'mandate_required');
    const other = await approved(wallet, { hostAllowlist: ['api.example.com'] });
    const spy = vi.spyOn(account, 'signTypedData');
    const err = await expectViolation(wallet.fetch(`${s.url}/predict`), 'host_not_allowed');
    expect(err.detail).toEqual({ host: new URL(s.url).host, mandateIds: [other.id] });
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'session', id: 's1' } }), 'no_held_mandate');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: other.id }), 'host_not_allowed');
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: 'im_missing' }), 'mandate_not_found');
    // a non-402 URL is refused just the same: the request never leaves
    await expectViolation(wallet.fetch(`${s.url}/nope`, { method: 'POST', body: 'x' }), 'host_not_allowed');
    expect(s.requests).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(wallet.report().policyDenials.map((d) => d.reason)).toEqual([
      'mandate_required',
      'host_not_allowed',
      'no_held_mandate',
      'host_not_allowed',
      'mandate_not_found',
      'host_not_allowed',
    ]);

    const good = await approved(wallet);
    const child = await wallet.delegateIntentMandate(good.id, childInput(), 'session:s1');
    expect((await wallet.fetch(`${s.url}/predict`)).status).toBe(200);
    expect(s.requests).toBe(2);
    expect((await wallet.fetch(`${s.url}/predict`, undefined, { caller: { kind: 'session', id: 's1' } })).status).toBe(200);
    expect((await wallet.fetch(`${s.url}/nope`)).status).toBe(404); // named host, plain response: passes through as before
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: child.id }), 'holder_mismatch');
    // only the allowlist is checked up front: the rest of the policy still runs at the 402
    wallet.setEnabled(good.id, false);
    const requests = s.requests;
    await expectViolation(wallet.fetch(`${s.url}/predict`, undefined, { mandateId: good.id }), 'mandate_disabled');
    expect(s.requests).toBe(requests + 1);
    // off by default
    const open = makeWallet();
    await approved(open.wallet, { hostAllowlist: ['api.example.com'] });
    await expectViolation(open.wallet.fetch(`${s.url}/predict`), 'host_not_allowed');
    expect(s.requests).toBe(requests + 2);
  });
});

// ---------------------------------------------------------------------------

/** A pid no process has (ESRCH from kill(pid, 0)). */
function deadPid(): number {
  for (const pid of [2_147_483_647, 99_999, 4_194_303, 65_535]) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no dead pid found');
}

describe('lock', () => {
  it('a second wallet on the same home refuses; dispose() releases; a stale lock from a dead pid is ignored', async () => {
    const first = makeWallet({ lock: true });
    const lockPath = join(first.dir, LOCK_FILE);
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    expect(lockedBy(first.dir)).toBe(process.pid);
    expect(() => makeWallet({ lock: true, mandatesPath: first.mandatesPath, ledgerPath: first.ledgerPath })).toThrow(
      new RegExp(`locked by pid ${process.pid}.*one wallet process per home`),
    );
    // advisory: a wallet that does not ask for the lock still opens (the CLI checks lockedBy itself)
    await approved(makeWallet({ mandatesPath: first.mandatesPath, ledgerPath: first.ledgerPath }).wallet);
    expect(lockedBy(first.dir)).toBe(process.pid);

    first.wallet.dispose();
    expect(existsSync(lockPath)).toBe(false);
    expect(lockedBy(first.dir)).toBeUndefined();
    first.wallet.dispose(); // idempotent
    const second = makeWallet({ lock: true, mandatesPath: first.mandatesPath, ledgerPath: first.ledgerPath });
    expect(lockedBy(first.dir)).toBe(process.pid);
    second.wallet.dispose();

    // a crashed process left its pid behind
    writeFileSync(lockPath, `${deadPid()}\n`, 'utf8');
    expect(lockedBy(first.dir)).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false); // removed on the way
    writeFileSync(lockPath, `${deadPid()}\n`, 'utf8');
    const third = makeWallet({ lock: true, mandatesPath: first.mandatesPath, ledgerPath: first.ledgerPath });
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
    third.wallet.dispose();
    writeFileSync(lockPath, 'garbage\n', 'utf8');
    expect(lockedBy(first.dir)).toBeUndefined();
    expect(lockedBy(join(root, 'never-existed'))).toBeUndefined();

    // dispose() only removes a lock that names this process
    const fourth = makeWallet({ lock: true, mandatesPath: first.mandatesPath, ledgerPath: first.ledgerPath });
    writeFileSync(lockPath, `${deadPid()}\n`, 'utf8');
    fourth.wallet.dispose();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('needs mandatesPath, and a refused store does not leave the home locked', () => {
    expect(() => makeWallet({ lock: true, mandatesPath: undefined })).toThrow(/`lock` needs `mandatesPath`/);
    const dir = join(root, 'lock-refused');
    mkdirSync(dir, { recursive: true });
    const mandatesPath = join(dir, 'mandates.json');
    writeFileSync(mandatesPath, JSON.stringify({ version: 1, mandates: [] }), 'utf8');
    expect(() => makeWallet({ lock: true, mandatesPath, ledgerPath: join(dir, 'ledger.jsonl') })).toThrow(/predates the v2 intent domain/);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(lockedBy(dir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('verifyMandates()', () => {
  it('reports every signed mandate whose signature does not recover to the payer', async () => {
    const { wallet, mandatesPath, ledgerPath } = makeWallet();
    const a = await approved(wallet);
    const b = await approved(wallet);
    await wallet.createIntentMandate(baseInput()); // a draft is not signed: not checked
    const child = await wallet.delegateIntentMandate(a.id, childInput(), 'session:s1');
    expect(await wallet.verifyMandates()).toEqual([]);

    // a mandate signed by another key, one whose terms were edited after signing, one with a garbage signature
    const stranger = makeWallet({ account: privateKeyToAccount(KEYS.stranger) });
    const foreign = await approved(stranger.wallet);
    const store = new IntentMandateStore(mandatesPath);
    store.upsert({ ...store.get(b.id)!, limitAmount: '999000000' });
    store.upsert({ ...store.get(child.id)!, holder: 'session:s2' });
    store.upsert(foreign);
    store.upsert(handMade({ id: 'im_garbage', signature: '0x1234' as Hex }));
    store.save();
    const again = makeWallet({ mandatesPath, ledgerPath }).wallet;
    expect(await again.verifyMandates()).toEqual([b.id, child.id, foreign.id, 'im_garbage']);
    expect(await wallet.verifyMandates()).toEqual([]); // the in-memory copy is untouched
    expect(await stranger.wallet.verifyMandates()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('reconcile() beside a live fetch()', () => {
  interface StubChain {
    blockTimestamp: number;
    used: (nonce: Hex) => Promise<boolean>;
  }
  function stubChain(wallet: MandateWallet, chain: StubChain): void {
    const pc = {
      getChainId: async () => CHAIN_ID,
      getBlock: async () => ({ number: 1n, timestamp: BigInt(chain.blockTimestamp) }),
      readContract: async (args: { args: [Address, Hex] }) => chain.used(args.args[1]),
      getContractEvents: async () => [],
    };
    (wallet as unknown as { publicClientCache: PublicClient }).publicClientCache = pc as unknown as PublicClient;
  }

  it('skips an in_flight row until validBefore; a row the fetch settled while the chain was awaited is only marked verified', async () => {
    const s = await serve();
    const fetchImpl = globalThis.fetch;
    let gate: Promise<void> | undefined;
    const { wallet, ledgerPath } = makeWallet({
      fetch: async (input, init) => {
        if (gate && new Headers(init?.headers).has('PAYMENT-SIGNATURE')) await gate;
        return fetchImpl(input, init);
      },
    });
    const m = await approved(wallet);
    const chain: StubChain = { blockTimestamp: nowSec(), used: async () => true };
    stubChain(wallet, chain);

    // (a) the paid request is held: the row is in_flight, the chain says used, reconcile leaves it to the fetch
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const inFlight = wallet.fetch(`${s.url}/predict`);
    while (readLedger(ledgerPath).length < 1) await sleep(5);
    const [row1] = readLedger(ledgerPath);
    expect(row1).toMatchObject({ status: 'unknown', error: 'in_flight', httpStatus: 0 });
    expect(await wallet.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [row1.nonce], verified: [] });
    expect(counters(wallet.getMandate(m.id))).toEqual({ spent: '0', pending: '1000' });
    release();
    expect((await inFlight).status).toBe(200);
    expect(counters(wallet.getMandate(m.id))).toEqual({ spent: '1000', pending: '0' });
    expect(readLedger(ledgerPath)[0].status).toBe('settled');
    expect(readLedger(ledgerPath)[0]).not.toHaveProperty('verified');

    // (b) chain time is past validBefore (what a crashed fetch looks like), but this fetch is alive and
    //     lands while reconcile awaits the chain: the row is re-read and not booked a second time
    gate = new Promise<void>((r) => (release = r));
    const late = wallet.fetch(`${s.url}/predict`);
    while (readLedger(ledgerPath).length < 2) await sleep(5);
    const row2 = readLedger(ledgerPath)[1];
    chain.blockTimestamp = row2.validBefore + 1;
    let settledMeanwhile: LedgerEntry | undefined;
    chain.used = async () => {
      release();
      await late; // the fetch books pending -> spent and writes 'settled'
      settledMeanwhile = readLedger(ledgerPath)[1];
      return true;
    };
    const r = await wallet.reconcile();
    expect(settledMeanwhile?.status).toBe('settled');
    expect(r).toEqual({ settled: [], expiredUnused: [], stillPending: [], verified: [row1.nonce, row2.nonce] });
    expect(counters(wallet.getMandate(m.id))).toEqual({ spent: '2000', pending: '0' }); // not 3000
    const rows = readLedger(ledgerPath);
    expect(rows[1]).toMatchObject({ status: 'settled', verified: true, transaction: settledMeanwhile?.transaction, httpStatus: 200 });
    expect(wallet.report().totals).toMatchObject({ spent: '2000', pending: '0', settled: 2 });
    expect(await wallet.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [], verified: [] });
  });

  it('a row a crashed fetch left in_flight is resolved once chain time is past validBefore: used -> settled (booked once), unused -> released', async () => {
    const { wallet, ledgerPath, mandatesPath } = makeWallet();
    const m = await approved(wallet);
    const l = new Ledger(ledgerPath);
    const base = (nonceByte: string, over: Partial<LedgerEntry>): LedgerEntry => {
      const nonce = ('0x' + nonceByte.repeat(32)) as Hex;
      return {
        v: 2,
        kind: 'payment',
        timestamp: 1,
        signedAt: 1,
        url: 'http://127.0.0.1/y',
        host: '127.0.0.1',
        resource: 'GET /y',
        network: NETWORK,
        asset: TOKEN,
        amount: '7',
        payer: payerAccount.address,
        payee: payeeAddress,
        intentMandateId: m.id,
        nonce,
        validBefore: 100,
        authorization: { from: payerAccount.address, to: payeeAddress, value: '7', validAfter: '0', validBefore: '100', nonce },
        signature: '0x' as Hex,
        httpStatus: 0,
        status: 'unknown',
        error: 'in_flight',
        ...over,
      };
    };
    l.append(base('01', {}));
    l.append(base('02', { amount: '11' }));
    const again = makeWallet({ mandatesPath, ledgerPath }).wallet;
    expect(counters(again.getMandate(m.id))).toEqual({ spent: '0', pending: '18' });
    const chain: StubChain = { blockTimestamp: 50, used: async (nonce) => nonce.startsWith('0x0101') };
    stubChain(again, chain);
    const [n1, n2] = l.read().map((e) => e.nonce);
    expect(await again.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [n1, n2], verified: [] });
    chain.blockTimestamp = 100;
    expect(await again.reconcile()).toEqual({ settled: [n1], expiredUnused: [n2], stillPending: [], verified: [] });
    expect(l.read().map((e) => [e.status, e.verified])).toEqual([
      ['settled', true],
      ['expired-unused', true],
    ]);
    expect(counters(again.getMandate(m.id))).toEqual({ spent: '7', pending: '0' });
    expect(await again.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [], verified: [] });
  });
});
