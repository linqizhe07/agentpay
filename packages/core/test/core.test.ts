import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HEADER,
  HINT_REASONS,
  MANDATE_TYPES,
  PAYEE_REASONS,
  POLICY_REASONS,
  SP_ERROR_CODES,
  WireError,
  assertCanonicalSignature,
  assertMandateShape,
  chainIdFromNetwork,
  decodeHeader,
  encodeHeader,
  formatUsdc,
  mandateDigest,
  mandateDomain,
  mandateToTuple,
  parseAmount,
  parsePrice,
  paymentModelContext,
  randomNonce,
  readMandatePayment,
  readPaymentRequired,
  readPaymentResponse,
  recoverMandateSigner,
  resourceRef,
  signMandate,
  signSpReceipt,
  verifySpReceipt,
  type Hex,
  type Mandate,
  type MandateDomain,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementInfo,
} from '../src/index.js';

// Hardhat dev accounts — famous public test keys, never used with real funds.
const payer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const sp = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const stranger = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');

const WALLET = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const domain: MandateDomain = { chainId: 31337, verifyingContract: WALLET };

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    owner: payer.address,
    token: TOKEN,
    payee: stranger.address,
    amount: '1000',
    nonce: '123456789',
    deadline: 1_800_000_000,
    ref: resourceRef('GET /predict'),
    ...overrides,
  };
}

function offer(): PaymentRequirements {
  return {
    scheme: 'aep2',
    network: 'eip155:31337',
    amount: '1000',
    asset: TOKEN,
    payTo: stranger.address,
    resource: 'GET /predict',
    maxTimeoutSeconds: 60,
    extra: { wallet: WALLET, sp: 'http://127.0.0.1:3001', spAddress: sp.address, settleWindowSeconds: 3600 },
  };
}

describe('money', () => {
  it('parses prices to 6dp atomic units', () => {
    expect(parsePrice('$0.01')).toBe(10000n);
    expect(parsePrice('0.001')).toBe(1000n);
    expect(parsePrice('$1')).toBe(1_000_000n);
    expect(parsePrice('$12.345678')).toBe(12_345_678n);
  });
  it('rejects garbage, zero, and absurd prices', () => {
    for (const bad of ['', 'abc', '$0', '0', '-1', '$0.0000001', '$1001']) {
      expect(() => parsePrice(bad), bad).toThrow(WireError);
    }
  });
  it('parseAmount accepts prices and bare atomic units', () => {
    expect(parseAmount('$1.50')).toBe(1_500_000n);
    expect(parseAmount('1500000')).toBe(1_500_000n);
    expect(parseAmount('0.5')).toBe(500_000n);
  });
  it('formats atomic units', () => {
    expect(formatUsdc(10000n)).toBe('$0.010000');
    expect(formatUsdc(-1_500_000n)).toBe('-$1.500000');
  });
  it('parses CAIP-2 eip155 networks', () => {
    expect(chainIdFromNetwork('eip155:84532')).toBe(84532);
    expect(() => chainIdFromNetwork('solana:mainnet')).toThrow(WireError);
  });
});

describe('headers', () => {
  it('round-trips objects through base64', () => {
    const obj = { a: 1, b: 'x' };
    expect(decodeHeader(encodeHeader(obj))).toEqual(obj);
  });

  it('reads the x402 envelope from PAYMENT-SIGNATURE (case-insensitive, Headers object too)', () => {
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: offer(),
      payload: { mandate: mandate(), payerSig: `0x${'ab'.repeat(65)}` },
    };
    const encoded = encodeHeader(payload);
    const fromBag = readMandatePayment({ 'payment-signature': encoded });
    expect(fromBag?.kind).toBe('x402');
    expect(fromBag?.payload).toEqual(payload);
    const fromHeaders = readMandatePayment(new Headers({ [HEADER.signature]: encoded }));
    expect(fromHeaders?.payload).toEqual(payload);
  });

  it('reads the legacy X-Payment-Mandate header as kind legacy', () => {
    const legacy = { mandate: mandate(), payerSig: `0x${'cd'.repeat(65)}` };
    const r = readMandatePayment({ 'x-payment-mandate': encodeHeader(legacy) });
    expect(r).toEqual({ kind: 'legacy', payload: legacy });
  });

  it('prefers PAYMENT-SIGNATURE when both are present', () => {
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: offer(),
      payload: { mandate: mandate(), payerSig: `0x${'ab'.repeat(65)}` },
    };
    const r = readMandatePayment({
      [HEADER.signature]: encodeHeader(payload),
      [HEADER.legacyMandate]: encodeHeader({ mandate: mandate(), payerSig: '0x00' }),
    });
    expect(r?.kind).toBe('x402');
  });

  it('returns undefined without a payment header and throws WireError on garbage', () => {
    expect(readMandatePayment({})).toBeUndefined();
    expect(() => readMandatePayment({ [HEADER.signature]: '%%%not-base64-json' })).toThrow(WireError);
    expect(() => readMandatePayment({ [HEADER.signature]: encodeHeader({ x402Version: 2 }) })).toThrow(WireError);
    expect(() => readMandatePayment({ [HEADER.legacyMandate]: encodeHeader({ mandate: 1 }) })).toThrow(WireError);
  });

  it('readPaymentRequired prefers the header and falls back to the body', () => {
    const body = { x402Version: 2 as const, accepts: [offer()] };
    expect(readPaymentRequired({ [HEADER.required]: encodeHeader(body) })).toEqual(body);
    expect(readPaymentRequired({}, JSON.stringify(body))).toEqual(body);
    expect(() => readPaymentRequired({}, 'not json')).toThrow(WireError);
  });

  it('readPaymentResponse decodes SettlementInfo', async () => {
    const receipt = await signSpReceipt(sp, domain, mandateDigest(domain, mandate()), 1_800_000_000);
    const info: SettlementInfo = {
      success: true,
      scheme: 'aep2',
      network: 'eip155:31337',
      payer: payer.address,
      transaction: '',
      status: 'enqueued',
      mandateDigest: receipt.mandateDigest,
      spReceipt: receipt,
    };
    expect(readPaymentResponse(new Headers({ [HEADER.response]: encodeHeader(info) }))).toEqual(info);
    expect(readPaymentResponse({})).toBeUndefined();
  });
});

describe('mandate typed data', () => {
  it('digest is deterministic and equals viem hashTypedData over the same struct', () => {
    const m = mandate();
    const a = mandateDigest(domain, m);
    const b = hashTypedData({
      domain: mandateDomain(domain),
      types: MANDATE_TYPES,
      primaryType: 'Mandate',
      message: mandateToTuple(m),
    });
    expect(a).toBe(b);
    expect(mandateDigest(domain, mandate({ amount: '1001' }))).not.toBe(a);
    expect(mandateDigest({ ...domain, chainId: 84532 }, m)).not.toBe(a);
  });

  it('signs and recovers the owner; tampering breaks recovery', async () => {
    const m = mandate();
    const sig = await signMandate(payer, domain, m);
    expect(await recoverMandateSigner(domain, m, sig)).toBe(payer.address);
    const tampered = mandate({ amount: '2000' });
    expect(await recoverMandateSigner(domain, tampered, sig)).not.toBe(payer.address);
    const strangerSig = await signMandate(stranger, domain, m);
    expect(await recoverMandateSigner(domain, m, strangerSig)).toBe(stranger.address);
  });

  it('rejects malleable encodings of a valid signature (high-s, v=0/1) like the contract does', async () => {
    const m = mandate();
    const sig = await signMandate(payer, domain, m);
    const r = sig.slice(2, 66);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130, 132), 16);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    // (r, n - s, flipped v) recovers the same address in viem but is rejected on-chain.
    const highS = `0x${r}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    await expect(recoverMandateSigner(domain, m, highS)).rejects.toThrow(/low-s/);
    // v encoded as 0/1 instead of 27/28.
    const yParity = `${sig.slice(0, 130)}${(v - 27).toString(16).padStart(2, '0')}` as Hex;
    await expect(recoverMandateSigner(domain, m, yParity)).rejects.toThrow(/v must be 27 or 28/);
    await expect(recoverMandateSigner(domain, m, '0x1234' as never)).rejects.toThrow(WireError);
    expect(() => assertCanonicalSignature(sig)).not.toThrow();
  });

  it('randomNonce yields distinct uint256 decimal strings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = randomNonce();
      expect(n).toMatch(/^\d+$/);
      expect(BigInt(n) < 1n << 256n).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(50);
  });

  it('resourceRef is sensitive to the quote id', () => {
    expect(resourceRef('GET /x')).toBe(resourceRef('GET /x'));
    expect(resourceRef('GET /x', 'q1')).not.toBe(resourceRef('GET /x'));
    expect(resourceRef('GET /x', 'q1')).not.toBe(resourceRef('GET /x', 'q2'));
  });

  it('assertMandateShape accepts a good mandate and rejects bad fields', () => {
    expect(() => assertMandateShape(mandate())).not.toThrow();
    const bad: unknown[] = [
      null,
      'x',
      mandate({ owner: '0x123' as never }),
      mandate({ amount: '-1' }),
      mandate({ amount: '1.5' }),
      mandate({ nonce: (1n << 256n).toString() }),
      mandate({ deadline: 1.5 }),
      mandate({ deadline: -1 }),
      mandate({ ref: '0x1234' as never }),
    ];
    for (const b of bad) expect(() => assertMandateShape(b)).toThrow(WireError);
  });
});

describe('sp receipt', () => {
  const now = 1_700_000_000;
  const m = mandate({ deadline: now + 7200 });
  const digest = mandateDigest(domain, m);

  it('signs and verifies', async () => {
    const r = await signSpReceipt(sp, domain, digest, now + 3600);
    expect(r.sp).toBe(sp.address);
    const ok = await verifySpReceipt(r, {
      domain,
      expectedSp: sp.address,
      mandateDigest: digest,
      mandateDeadline: m.deadline,
      now,
      maxWindowSeconds: 3600,
    });
    expect(ok).toEqual({ ok: true });
  });

  it('reports each problem', async () => {
    const r = await signSpReceipt(sp, domain, digest, now + 3600);
    const base = { domain, now };
    expect(await verifySpReceipt({ ...r, spEnqueueSig: `0x${'00'.repeat(65)}` }, base)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySpReceipt({ ...r, sp: stranger.address }, base)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySpReceipt({ ...r, enqueueDeadline: now + 3601 }, base)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySpReceipt(r, { ...base, expectedSp: stranger.address })).toEqual({ ok: false, reason: 'sp_mismatch' });
    expect(await verifySpReceipt(r, { ...base, mandateDigest: mandateDigest(domain, mandate()) })).toEqual({ ok: false, reason: 'digest_mismatch' });
    expect(await verifySpReceipt(r, { ...base, now: now + 3601 })).toEqual({ ok: false, reason: 'deadline_past' });
    expect(await verifySpReceipt(r, { ...base, maxWindowSeconds: 1800 })).toEqual({ ok: false, reason: 'deadline_too_far' });
    expect(await verifySpReceipt(r, { ...base, mandateDeadline: now + 1800 })).toEqual({ ok: false, reason: 'deadline_after_mandate' });
    expect(await verifySpReceipt({ ...r, enqueueDeadline: 'soon' as never }, base)).toEqual({ ok: false, reason: 'malformed' });
    // A different wallet deployment is a different domain: the receipt must not verify there.
    expect(await verifySpReceipt(r, { ...base, domain: { ...domain, verifyingContract: TOKEN } })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('hints', () => {
  it('covers every policy, payee and SP reason', () => {
    for (const reason of [...POLICY_REASONS, ...PAYEE_REASONS, ...SP_ERROR_CODES]) {
      expect(HINT_REASONS, reason).toContain(reason);
      const ctx = paymentModelContext(reason, { amount: '1000', remaining: '0' });
      expect(ctx.protocol).toBe('aep2');
      expect(ctx.reason).toBe(reason);
      expect(ctx.summary.length).toBeGreaterThan(10);
      expect(ctx.remediation.length).toBeGreaterThan(0);
    }
  });
  it('falls back to a generic hint for unknown reasons', () => {
    const ctx = paymentModelContext('something_new');
    expect(ctx.reason).toBe('something_new');
    expect(ctx.remediation.length).toBe(1);
  });
});
