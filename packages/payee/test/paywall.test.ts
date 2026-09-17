import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import express, { type Request } from 'express';
import {
  HEADER,
  decodeHeader,
  encodeHeader,
  resourceRef,
  verifySpReceipt,
  type Address,
  type MandateDomain,
  type PaymentRequiredBody,
  type SettlementInfo,
} from '@agentpay/core';
import { buildOffer, createMandatePaywall, type MandatePaywallOptions } from '../src/index.js';
import { startStubSp, type StubSp } from './stub-sp.js';
import {
  KEYS,
  accounts,
  call,
  closeServer,
  getOffer,
  legacyHeader,
  listen,
  nowSec,
  readSettlement,
  signFor,
  x402Header,
  type Signed,
} from './helpers.js';

const NETWORK = 'eip155:31337';
// Offline suite: nothing is read on-chain, so any addresses will do.
const WALLET = '0x1000000000000000000000000000000000000001' as Address;
const USDC = '0x2000000000000000000000000000000000000002' as Address;
const SETTLE_WINDOW = 120;
const SP_TIMEOUT_MS = 500;
const domain: MandateDomain = { chainId: 31337, verifyingContract: WALLET };

async function json402(res: Response): Promise<PaymentRequiredBody> {
  expect(res.status).toBe(402);
  const body = (await res.json()) as PaymentRequiredBody;
  // header and body always carry the same JSON
  expect(decodeHeader<PaymentRequiredBody>(res.headers.get(HEADER.required)!)).toEqual(body);
  return body;
}

describe('createMandatePaywall (offline, verifyOnChain: false)', () => {
  let stub: StubSp;
  let server: Server;
  let base: string;
  let common: Omit<MandatePaywallOptions, 'price'>;
  let predictOptions: MandatePaywallOptions;
  const served = { predict: 0, analyze: 0, quote: 0, nohints: 0, fakechain: 0, text: 0 };
  const enqueued: Array<{ info: SettlementInfo; path: string }> = [];
  let lastLocals: unknown;
  const fake = { debitable: 10_000n, used: false, fail: false };
  const fakeClient = {
    readContract: async (args: { functionName: string }): Promise<unknown> => {
      if (fake.fail) throw new Error('boom: rpc down\nsecond line');
      if (args.functionName === 'debitableBalance') return fake.debitable;
      if (args.functionName === 'usedNonces') return fake.used;
      throw new Error(`unexpected view ${args.functionName}`);
    },
  };

  beforeAll(async () => {
    stub = await startStubSp({ key: KEYS.sp, domain, settleWindowSeconds: SETTLE_WINDOW });
    common = {
      network: NETWORK,
      asset: USDC,
      payTo: accounts.payee.address,
      wallet: WALLET,
      sp: { url: stub.url, address: stub.address, settleWindowSeconds: SETTLE_WINDOW, timeoutMs: SP_TIMEOUT_MS },
      verifyOnChain: false,
      onEnqueued: (info, req) => enqueued.push({ info, path: req.path }),
    };
    predictOptions = { ...common, price: '$0.001' };

    const app = express();
    app.use(express.json());
    app.get('/predict', createMandatePaywall(predictOptions), (_req, res) => {
      served.predict += 1;
      lastLocals = res.locals.aep2;
      res.json({ symbol: 'ETH-USD', price: 1 });
    });
    app.post('/analyze', createMandatePaywall({ ...common, price: '$0.01', includeBodyPaymentField: true }), (req, res) => {
      served.analyze += 1;
      res.json({ ok: true, echo: req.body });
    });
    app.get(
      '/quote',
      createMandatePaywall({
        ...common,
        price: '$0.001',
        quoteIdOf: (req: Request) => (typeof req.query.quote === 'string' ? req.query.quote : undefined),
      }),
      (_req, res) => {
        served.quote += 1;
        res.json({ quoted: true });
      },
    );
    app.get('/nohints', createMandatePaywall({ ...common, price: '$0.001', includeHints: false }), (_req, res) => {
      served.nohints += 1;
      res.json({ ok: true });
    });
    app.get(
      '/fakechain',
      createMandatePaywall({ ...common, price: '$0.001', verifyOnChain: true, publicClient: fakeClient }),
      (_req, res) => {
        served.fakechain += 1;
        res.json({ ok: true });
      },
    );
    app.get('/text', createMandatePaywall({ ...common, price: '$0.001', includeBodyPaymentField: true }), (_req, res) => {
      served.text += 1;
      res.type('text/plain').send('plain');
    });
    ({ server, base } = await listen(app));
  });

  afterEach(() => {
    // isolate tests: a failing assertion must not leave the stub or fake chain in a bad state
    stub.mode = 'ok';
    fake.debitable = 10_000n;
    fake.used = false;
    fake.fail = false;
  });

  afterAll(async () => {
    await closeServer(server);
    await stub?.close();
  });

  // ---------------------------------------------------------------- 1. offer

  it('answers a bare request with a 402 offer in both header and body, plus a mandate_required hint', async () => {
    const res = await fetch(`${base}/predict`);
    const body = await json402(res);
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('mandate_required');
    expect(body.payment_model_context).toMatchObject({ protocol: 'aep2', reason: 'mandate_required' });
    expect(body.payment_model_context?.remediation.length).toBeGreaterThan(0);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toEqual({
      scheme: 'aep2',
      network: NETWORK,
      amount: '1000',
      asset: USDC,
      payTo: accounts.payee.address,
      resource: 'GET /predict',
      maxTimeoutSeconds: 60,
      extra: { wallet: WALLET, sp: stub.url, spAddress: stub.address, settleWindowSeconds: SETTLE_WINDOW },
    });
    expect(body.accepts[0]).toEqual(buildOffer(predictOptions, 'GET /predict'));

    const analyze = await getOffer(base, '/analyze', 'POST');
    expect(analyze).toMatchObject({ amount: '10000', resource: 'POST /analyze' });
    expect(served.predict + served.analyze).toBe(0);
  });

  // ------------------------------------------------------- 1. invalid_payment

  it('rejects undecodable or malformed payment headers with 400 invalid_payment', async () => {
    const cases: Array<[string, boolean]> = [
      ['not base64 json at all', false],
      ['not base64 json at all', true],
      [encodeHeader({ x402Version: 2, accepted: {}, payload: { nope: true } }), false],
      [encodeHeader({ mandate: 'x' }), true],
      [encodeHeader(null), false],
    ];
    for (const [header, legacy] of cases) {
      const res = await call(base, '/predict', { header, legacy });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; payment_model_context?: { reason: string } };
      expect(body.error).toMatch(/^invalid_payment: /);
      expect(body.payment_model_context?.reason).toBe('invalid_payment');
    }
    // unsupported envelope version
    const offer = await getOffer(base, '/predict');
    const signed = await signFor(domain, offer);
    const v1 = encodeHeader({ x402Version: 1, accepted: offer, payload: signed.payload });
    const res = await call(base, '/predict', { header: v1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/x402Version/);
    expect(served.predict).toBe(0);
  });

  // ---------------------------------------------------------- 2. offer_mismatch

  it('refuses a tampered echoed offer with offer_mismatch (x402 envelope only)', async () => {
    const offer = await getOffer(base, '/predict');
    const signed = await signFor(domain, offer);
    const tampered = [
      { ...offer, amount: '500' },
      { ...offer, payTo: accounts.stranger.address },
      { ...offer, asset: WALLET },
      { ...offer, network: 'eip155:84532' },
      { ...offer, resource: 'GET /other' },
      { ...offer, scheme: 'exact' as unknown as 'aep2' },
      { ...offer, extra: { ...offer.extra, wallet: USDC } },
    ];
    for (const echoed of tampered) {
      const res = await call(base, '/predict', { header: x402Header(echoed, signed.payload) });
      const body = await json402(res);
      expect(body.error).toMatch(/^offer_mismatch/);
      expect(body.payment_model_context?.reason).toBe('offer_mismatch');
      expect(body.accepts[0]).toEqual(offer); // the real terms are re-advertised
    }
    // missing accepted entirely
    const res = await call(base, '/predict', { header: encodeHeader({ x402Version: 2, payload: signed.payload }) });
    expect((await json402(res)).error).toMatch(/^offer_mismatch/);
    expect(served.predict).toBe(0);
    expect(stub.calls).toHaveLength(0);

    // address case differences are not a mismatch: this one goes all the way through
    const lower = { ...offer, asset: offer.asset.toLowerCase() as Address, payTo: offer.payTo.toLowerCase() as Address };
    const ok = await call(base, '/predict', { header: x402Header(lower, signed.payload) });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect(served.predict).toBe(1);
  });

  // -------------------------------------------------------- 3. mandate shape

  it('rejects mandates that fail assertMandateShape with 400 invalid_payment', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const bad = [
      { amount: '1.5' },
      { nonce: '-1' },
      { deadline: 'soon' },
      { ref: '0x12' },
      { owner: 'alice' },
    ];
    for (const patch of bad) {
      const signed = await signFor(domain, offer);
      const payload = { ...signed.payload, mandate: { ...signed.mandate, ...patch } };
      for (const legacy of [false, true]) {
        const header = legacy ? legacyHeader(payload as never) : x402Header(offer, payload as never);
        const res = await call(base, '/predict', { header, legacy });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toMatch(/^invalid_payment: mandate\./);
      }
    }
    expect(served.predict).toBe(served0);
  });

  // ---------------------------------------------------------- 3. mandate terms

  it('enforces the offer terms in order: payee, token, amount, deadline (expired / too short), ref', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const calls0 = stub.calls.length;
    const t = nowSec();
    const cases: Array<[Parameters<typeof signFor>[2], string]> = [
      [{ payee: accounts.stranger.address }, 'invalid_payee'],
      [{ token: WALLET }, 'invalid_token'],
      [{ amount: '999' }, 'invalid_amount'],
      [{ deadline: t + 10 }, 'mandate_expired'],
      [{ deadline: t + 30 }, 'mandate_expired'], // deadline must EXCEED now + 30s margin
      [{ deadline: t + 60 }, 'mandate_deadline_too_short'],
      [{ ref: resourceRef('GET /other') }, 'invalid_ref'],
      [{ ref: resourceRef('GET /predict', 'q-1') }, 'invalid_ref'],
      // several violations at once: the first in order wins
      [{ payee: accounts.stranger.address, token: WALLET, amount: '1' }, 'invalid_payee'],
      [{ token: WALLET, amount: '1', deadline: t + 10 }, 'invalid_token'],
    ];
    for (const [overrides, reason] of cases) {
      const signed = await signFor(domain, offer, overrides);
      for (const legacy of [false, true]) {
        const header = legacy ? legacyHeader(signed.payload) : x402Header(offer, signed.payload);
        const res = await call(base, '/predict', { header, legacy });
        const body = await json402(res);
        expect(body.error, `${reason} legacy=${legacy}`).toMatch(new RegExp(`^${reason}`));
        expect(body.payment_model_context?.reason).toBe(reason);
      }
    }
    // the too-short hint names the settle window
    const short = await signFor(domain, offer, { deadline: t + 60 });
    const res = await call(base, '/predict', { header: x402Header(offer, short.payload) });
    const body = await json402(res);
    expect(body.payment_model_context?.summary).toContain(String(SETTLE_WINDOW));
    expect(served.predict).toBe(served0);
    expect(stub.calls).toHaveLength(calls0); // the SP was never contacted
  });

  // ------------------------------------------------------ 4. invalid_signature

  it('refuses signatures that do not recover to mandate.owner, and malformed ones', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const calls0 = stub.calls.length;

    // signed by the stranger, but claiming the payer as owner
    const forged = await signFor(domain, offer, { owner: accounts.payer.address }, accounts.stranger);
    let res = await call(base, '/predict', { header: x402Header(offer, forged.payload) });
    let body = await json402(res);
    expect(body.error).toMatch(/^invalid_signature/);
    expect(body.payment_model_context?.reason).toBe('invalid_signature');

    // valid signature over different fields (amount raised after signing)
    const signed = await signFor(domain, offer);
    const edited = { ...signed.payload, mandate: { ...signed.mandate, amount: '5000' } };
    res = await call(base, '/predict', { header: x402Header(offer, edited) });
    expect((await json402(res)).error).toMatch(/^invalid_signature/);

    // signature signed under another wallet domain
    const otherDomain: MandateDomain = { chainId: 31337, verifyingContract: USDC };
    const wrongDomain = await signFor(otherDomain, offer);
    res = await call(base, '/predict', { header: x402Header(offer, wrongDomain.payload) });
    expect((await json402(res)).error).toMatch(/^invalid_signature/);

    // garbage signature string
    const garbage = { ...signed.payload, payerSig: '0x1234' as `0x${string}` };
    res = await call(base, '/predict', { header: legacyHeader(garbage), legacy: true });
    body = await json402(res);
    expect(body.error).toMatch(/^invalid_signature/);

    expect(served.predict).toBe(served0);
    expect(stub.calls).toHaveLength(calls0);
  });

  // ------------------------------------------------------------- 8. happy path

  let happy: Signed;
  let happyHeader: string;
  let happyInfo: SettlementInfo;

  it('enqueues a valid mandate: 200, untouched body, headers, verifiable receipt, res.locals, onEnqueued', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const enqueued0 = enqueued.length;
    happy = await signFor(domain, offer, { amount: '2000' }); // paying more than the price is fine
    happyHeader = x402Header(offer, happy.payload);

    const res = await call(base, '/predict', { header: happyHeader });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ symbol: 'ETH-USD', price: 1 }); // no payment field by default
    expect(served.predict).toBe(served0 + 1);

    happyInfo = readSettlement(res);
    expect(happyInfo).toMatchObject({
      success: true,
      scheme: 'aep2',
      network: NETWORK,
      payer: accounts.payer.address,
      transaction: '',
      status: 'enqueued',
      mandateDigest: happy.digest,
    });
    expect(happyInfo.spReceipt.sp).toBe(stub.address);
    expect(happyInfo.spReceipt.mandateDigest).toBe(happy.digest);
    expect(happyInfo.spReceipt.enqueueDeadline).toBeLessThanOrEqual(nowSec() + SETTLE_WINDOW + 1);
    expect(
      await verifySpReceipt(happyInfo.spReceipt, {
        domain,
        expectedSp: stub.address,
        mandateDigest: happy.digest,
        mandateDeadline: happy.mandate.deadline,
        now: nowSec(),
        maxWindowSeconds: SETTLE_WINDOW + 60,
      }),
    ).toEqual({ ok: true });

    expect(lastLocals).toEqual(happyInfo);
    expect(enqueued).toHaveLength(enqueued0 + 1);
    expect(enqueued[enqueued.length - 1]).toEqual({ info: happyInfo, path: '/predict' });
    expect(stub.calls[stub.calls.length - 1]).toEqual(happy.payload); // exactly {mandate, payerSig} was forwarded
  });

  // ------------------------------------------------------------------ 5. replay

  it('answers a replayed mandate with 409 replay and does NOT run the handler', async () => {
    const served0 = served.predict;
    const calls0 = stub.calls.length;
    for (const [header, legacy] of [
      [happyHeader, false],
      [legacyHeader(happy.payload), true], // same digest through the other header: still a replay
    ] as const) {
      const res = await call(base, '/predict', { header, legacy });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; mandateDigest: string; payment_model_context?: { reason: string } };
      expect(body.error).toBe('replay');
      expect(body.mandateDigest).toBe(happy.digest);
      expect(body.payment_model_context?.reason).toBe('replay');
      expect(res.headers.get(HEADER.response)).toBeNull();
    }
    expect(served.predict).toBe(served0);
    expect(stub.calls).toHaveLength(calls0);
  });

  // ------------------------------------------------------------- legacy header

  it('accepts the legacy X-Payment-Mandate header (no offer echo to check)', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const signed = await signFor(domain, offer);
    const res = await call(base, '/predict', { header: legacyHeader(signed.payload), legacy: true });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(readSettlement(res).mandateDigest).toBe(signed.digest);
    expect(served.predict).toBe(served0 + 1);
  });

  // --------------------------------------------------- 7. settlement_unavailable

  it('releases the claim when the SP is down, so the same mandate succeeds once (and only once) when it is back', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const signed = await signFor(domain, offer);
    const header = x402Header(offer, signed.payload);

    stub.mode = 'down';
    let res = await call(base, '/predict', { header });
    let body = await json402(res);
    expect(body.error).toBe('settlement_unavailable: unreachable');
    expect(body.payment_model_context?.reason).toBe('settlement_unavailable');
    expect(body.payment_model_context?.summary).toContain('unreachable');
    expect(res.headers.get(HEADER.response)).toBeNull();
    expect(served.predict).toBe(served0);

    stub.mode = 'ok';
    res = await call(base, '/predict', { header });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(readSettlement(res).mandateDigest).toBe(signed.digest);
    expect(served.predict).toBe(served0 + 1);

    res = await call(base, '/predict', { header });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('replay');
    expect(served.predict).toBe(served0 + 1);
  });

  it('treats an old created:false answer from the SP as a replay (payee restart), 409 with the claim released', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const signed = await signFor(domain, offer);
    const header = x402Header(offer, signed.payload);

    stub.mode = 'duplicate'; // the SP has held this digest for two minutes: another payee instance served it
    let res = await call(base, '/predict', { header });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('replay');
    expect(res.headers.get(HEADER.response)).toBeNull();
    expect(served.predict).toBe(served0);

    // The claim was released: a fresh SP answer for the same mandate still delivers exactly once.
    stub.mode = 'ok';
    res = await call(base, '/predict', { header });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(served.predict).toBe(served0 + 1);
  });

  it('carries the SP error code on rejection (settlement_unavailable: <code>) and releases the claim', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const signed = await signFor(domain, offer);
    const header = x402Header(offer, signed.payload);

    stub.mode = 'reject';
    stub.rejectCode = 'sp_not_authorized';
    stub.rejectStatus = 403;
    let body = await json402(await call(base, '/predict', { header }));
    expect(body.error).toBe('settlement_unavailable: sp_not_authorized');
    expect(body.payment_model_context?.summary).toContain('sp_not_authorized');

    stub.rejectCode = 'insufficient_balance';
    stub.rejectStatus = 402;
    body = await json402(await call(base, '/predict', { header }));
    expect(body.error).toBe('settlement_unavailable: insufficient_balance');

    stub.rejectCode = 'deadline_too_soon';
    stub.rejectStatus = 400;
    body = await json402(await call(base, '/predict', { header }));
    expect(body.error).toBe('settlement_unavailable: deadline_too_soon');
    expect(served.predict).toBe(served0);

    stub.mode = 'ok';
    const res = await call(base, '/predict', { header });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(served.predict).toBe(served0 + 1);
  });

  it('times out a slow SP (settlement_unavailable: timeout) and releases the claim', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const signed = await signFor(domain, offer);
    const header = x402Header(offer, signed.payload);

    stub.mode = 'slow';
    const started = Date.now();
    const body = await json402(await call(base, '/predict', { header }));
    expect(Date.now() - started).toBeLessThan(SP_TIMEOUT_MS + 1500);
    expect(body.error).toBe('settlement_unavailable: timeout');
    expect(served.predict).toBe(served0);

    stub.mode = 'ok';
    const res = await call(base, '/predict', { header });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(served.predict).toBe(served0 + 1);
  });

  // ------------------------------------------------------- 7. invalid_sp_receipt

  it('refuses receipts that do not verify: bad-sig, wrong-sp, late-deadline (claim released each time)', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const cases: Array<[StubSp['mode'], string]> = [
      ['bad-sig', 'bad_signature'],
      ['wrong-sp', 'sp_mismatch'],
      ['late-deadline', 'deadline_too_far'],
    ];
    for (const [i, [mode, problem]] of cases.entries()) {
      const signed = await signFor(domain, offer);
      const header = x402Header(offer, signed.payload);
      stub.mode = mode;
      const body = await json402(await call(base, '/predict', { header }));
      expect(body.error).toBe(`invalid_sp_receipt: ${problem}`);
      expect(body.payment_model_context?.reason).toBe('invalid_sp_receipt');
      expect(served.predict).toBe(served0 + i);

      stub.mode = 'ok';
      const res = await call(base, '/predict', { header });
      expect(res.status, `retry after ${mode}`).toBe(200);
      await res.arrayBuffer();
    }
    expect(served.predict).toBe(served0 + cases.length);
  });

  // ------------------------------------------------- includeBodyPaymentField

  it('adds a payment field to JSON bodies only when includeBodyPaymentField is on', async () => {
    const offer = await getOffer(base, '/analyze', 'POST');
    const signed = await signFor(domain, offer);
    const res = await call(base, '/analyze', {
      method: 'POST',
      header: x402Header(offer, signed.payload),
      body: { text: 'hello' },
    });
    expect(res.status).toBe(200);
    const info = readSettlement(res);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      echo: { text: 'hello' },
      payment: { status: 'enqueued', mandateDigest: signed.digest, spReceipt: info.spReceipt },
    });
    expect(served.analyze).toBe(1);

    // non-JSON bodies are never rewritten, even with the option on
    const textOffer = await getOffer(base, '/text');
    const textSigned = await signFor(domain, textOffer);
    const textRes = await call(base, '/text', { header: x402Header(textOffer, textSigned.payload) });
    expect(textRes.status).toBe(200);
    expect(textRes.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await textRes.text()).toBe('plain');
    expect(readSettlement(textRes).mandateDigest).toBe(textSigned.digest);
  });

  // ------------------------------------------------------------- quoteIdOf

  it('binds quoteIdOf into the offer extra and the mandate ref', async () => {
    const offer = await getOffer(base, '/quote?quote=q-1');
    expect(offer.resource).toBe('GET /quote');
    expect(offer.extra.quoteId).toBe('q-1');

    const wrongQuote = await signFor(domain, offer, { ref: resourceRef('GET /quote', 'q-2') });
    let body = await json402(await call(base, '/quote?quote=q-1', { header: x402Header(offer, wrongQuote.payload) }));
    expect(body.error).toMatch(/^invalid_ref/);

    const noQuote = await signFor(domain, offer, { ref: resourceRef('GET /quote') });
    body = await json402(await call(base, '/quote?quote=q-1', { header: x402Header(offer, noQuote.payload) }));
    expect(body.error).toMatch(/^invalid_ref/);

    // a mandate for q-1 presented against the q-2 quote is likewise refused
    const right = await signFor(domain, offer);
    body = await json402(await call(base, '/quote?quote=q-2', { header: x402Header(offer, right.payload) }));
    expect(body.error).toMatch(/^invalid_ref/);
    expect(served.quote).toBe(0);

    const res = await call(base, '/quote?quote=q-1', { header: x402Header(offer, right.payload) });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(served.quote).toBe(1);

    // without a quote the offer carries no quoteId and the plain resource ref is expected
    const plain = await getOffer(base, '/quote');
    expect(plain.extra).not.toHaveProperty('quoteId');
    const plainSigned = await signFor(domain, plain);
    expect(plainSigned.mandate.ref).toBe(resourceRef('GET /quote'));
    const plainRes = await call(base, '/quote', { header: x402Header(plain, plainSigned.payload) });
    expect(plainRes.status).toBe(200);
    await plainRes.arrayBuffer();
  });

  // ---------------------------------------------------------------- hints off

  it('omits payment_model_context when includeHints is false', async () => {
    const res = await fetch(`${base}/nohints`);
    const body = await json402(res);
    expect(body.error).toBe('mandate_required');
    expect(body).not.toHaveProperty('payment_model_context');

    const offer = body.accepts[0];
    const bad = await signFor(domain, offer, { amount: '1' });
    const refused = await json402(await call(base, '/nohints', { header: x402Header(offer, bad.payload) }));
    expect(refused.error).toMatch(/^invalid_amount/);
    expect(refused).not.toHaveProperty('payment_model_context');
  });

  // ------------------------------------------------- 6. on-chain pre-checks

  it('pre-checks the wallet through an injected client: insufficient_balance, nonce_used, chain_unavailable (fail closed)', async () => {
    const offer = await getOffer(base, '/fakechain');
    const signed = await signFor(domain, offer);
    const header = x402Header(offer, signed.payload);
    const calls0 = stub.calls.length;

    fake.debitable = 999n;
    let body = await json402(await call(base, '/fakechain', { header }));
    expect(body.error).toMatch(/^insufficient_balance/);
    expect(body.payment_model_context?.summary).toContain('999');

    fake.debitable = 1000n; // exactly the amount is enough
    fake.used = true;
    body = await json402(await call(base, '/fakechain', { header }));
    expect(body.error).toMatch(/^nonce_used/);

    fake.used = false;
    fake.fail = true;
    body = await json402(await call(base, '/fakechain', { header }));
    expect(body.error).toBe('chain_unavailable: boom: rpc down');
    expect(body.payment_model_context?.reason).toBe('chain_unavailable');

    expect(served.fakechain).toBe(0);
    expect(stub.calls).toHaveLength(calls0); // refused before the SP was contacted

    fake.fail = false;
    const res = await call(base, '/fakechain', { header }); // the claim was released each time
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(served.fakechain).toBe(1);
    expect(stub.calls).toHaveLength(calls0 + 1);
  });

  // ------------------------------------------------------------- construction

  it('rejects unusable configuration at construction time', () => {
    const base: MandatePaywallOptions = { ...common, price: '$0.001' };
    expect(() => createMandatePaywall({ ...base, price: '$0' })).toThrow(/positive/);
    expect(() => createMandatePaywall({ ...base, price: 'free' })).toThrow(/unparseable price/);
    expect(() => createMandatePaywall({ ...base, network: 'solana:mainnet' })).toThrow(/eip155/);
    expect(() => createMandatePaywall({ ...base, verifyOnChain: true })).toThrow(/publicClient or options.rpcUrl/);
    expect(() => createMandatePaywall({ ...base, sp: { ...base.sp, settleWindowSeconds: 0 } })).toThrow(/settleWindowSeconds/);
    expect(() => createMandatePaywall({ ...base, payTo: 'bob' as Address })).toThrow(/payTo/);
    // verifyOnChain defaults on for hardhat with a source, off without one
    expect(() => createMandatePaywall({ ...base, verifyOnChain: undefined })).not.toThrow();
    expect(() => createMandatePaywall({ ...base, verifyOnChain: undefined, rpcUrl: 'http://127.0.0.1:1' })).not.toThrow();
    // sub-cent prices are fine
    expect(buildOffer({ ...base, price: '$0.000001' }, 'GET /x').amount).toBe('1');
  });
});
