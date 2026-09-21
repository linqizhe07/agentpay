import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { InMemoryIdempotencyStore, createPaywall, type Paywall } from '../src/index.js';
import { accounts, closeServer, getOffer, listen, pay, paymentFor, readSettlement, refusalReason } from './helpers.js';
import { startStubFacilitator, type StubFacilitator } from './stub-facilitator.js';

// Offline suite: a stub facilitator answers, nothing touches a chain.
const NETWORK = 'eip155:31337';

const keyOf = (payload: { payload: unknown }): string => {
  const a = (payload.payload as { authorization: { from: string; nonce: string } }).authorization;
  return `${a.from}:${a.nonce}`;
};
const USDC = '0x2000000000000000000000000000000000000002' as const;

describe('createPaywall (offline, stub facilitator)', () => {
  let facilitator: StubFacilitator;
  let paywall: Paywall;
  let server: Server;
  let base: string;
  let served = 0;
  let settledEvents: Array<{ transaction: string; payer?: string }> = [];
  let handlerStatus = 200;

  beforeAll(async () => {
    facilitator = await startStubFacilitator({ network: NETWORK, address: accounts.facilitator.address });
    paywall = createPaywall({
      facilitator: { url: facilitator.url, timeoutMs: 500 },
      network: NETWORK,
      asset: USDC,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: accounts.payee.address,
      onSettled: (result) => settledEvents.push({ transaction: result.transaction, payer: result.payer }),
      log: () => {},
    });
    const app = express();
    app.use(express.json());
    app.get('/predict', paywall.charge('$0.001', { description: 'a prediction', mimeType: 'application/json' }), (_req, res) => {
      served++;
      res.status(handlerStatus).json({ ok: handlerStatus < 400 });
    });
    app.get('/cheap', paywall.charge('$0.001'), (_req, res) => {
      served++;
      res.json({ route: 'cheap' });
    });
    app.post('/analyze', paywall.charge('$0.01'), (req, res) => {
      served++;
      res.json({ echo: req.body });
    });
    app.get('/nohints', createPaywall({
      facilitator: { url: facilitator.url },
      network: NETWORK,
      asset: USDC,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: accounts.payee.address,
      includeHints: false,
      log: () => {},
    }).charge('$0.001'), (_req, res) => res.json({}));
    ({ server, base } = await listen(app));
  });

  afterAll(async () => {
    await closeServer(server);
    await facilitator.close();
  });

  afterEach(() => {
    facilitator.mode = { kind: 'ok' };
    facilitator.calls.length = 0;
    served = 0;
    settledEvents = [];
    handlerStatus = 200;
  });

  it('answers 402 with the x402 V2 offer in the header and hints in the body', async () => {
    const { res, required, body } = await getOffer(`${base}/predict`);
    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(required.x402Version).toBe(2);
    expect(required.error).toBe('Payment required');
    expect(required.resource).toEqual({ url: `${base}/predict`, description: 'a prediction', mimeType: 'application/json' });
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toEqual({
      scheme: 'exact',
      network: NETWORK,
      asset: USDC,
      amount: '1000',
      payTo: accounts.payee.address,
      maxTimeoutSeconds: 60,
      extra: { name: MOCK_USDC_DOMAIN.name, version: MOCK_USDC_DOMAIN.version, assetTransferMethod: 'eip3009' },
    });
    expect(body).toMatchObject({ x402Version: 2, error: 'payment_required' });
    expect(body.payment_model_context).toMatchObject({ protocol: 'x402', reason: 'payment_required' });
    expect(body.payment_model_context.commands).toContain('agentpay pay <url>');
    expect(served).toBe(0);
  });

  it('includeHints: false leaves the body empty', async () => {
    const { body } = await getOffer(`${base}/nohints`);
    expect(body).toEqual({});
  });

  it('serves a paid call: verify, handler, settle, PAYMENT-RESPONSE', async () => {
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/predict`, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const settlement = readSettlement(res);
    expect(settlement).toMatchObject({ success: true, network: NETWORK, payer: accounts.payer.address });
    expect(settlement!.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(facilitator.calls.map((c) => c.route)).toEqual(['verify', 'settle']);
    // The facilitator sees our requirements, never the client's echo.
    expect(facilitator.calls[1]!.body.paymentRequirements).toEqual(required.accepts[0]);
    expect(served).toBe(1);
    expect(settledEvents).toEqual([{ transaction: settlement!.transaction, payer: accounts.payer.address }]);
    expect(paywall.store.size).toBe(1); // retained: a replay is refused locally
  });

  it('refuses a replay of a settled authorization without asking the facilitator', async () => {
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    expect((await pay(`${base}/predict`, payload)).status).toBe(200);
    facilitator.calls.length = 0;
    const again = await pay(`${base}/predict`, payload);
    expect(again.status).toBe(402);
    expect(refusalReason(again)).toBe('replay');
    expect(facilitator.calls).toHaveLength(0);
    expect(served).toBe(1);
  });

  it('serves one of two concurrent presentations of the same authorization', async () => {
    facilitator.mode = { kind: 'slow', ms: 50 };
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const [a, b] = await Promise.all([pay(`${base}/predict`, payload), pay(`${base}/predict`, payload)]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(facilitator.calls.filter((c) => c.route === 'settle')).toHaveLength(1);
    expect(served).toBe(1);
  });

  it('refuses the same authorization on another route with the same terms while it is in flight', async () => {
    facilitator.mode = { kind: 'slow', ms: 80 };
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const [a, b] = await Promise.all([pay(`${base}/predict`, payload), pay(`${base}/cheap`, payload)]);
    expect([a.status, b.status].sort()).toEqual([200, 402]);
    expect(served).toBe(1);
  });

  it('refuses a payment whose echoed terms differ from the route (amount, payTo)', async () => {
    const post = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } };
    const { required } = await getOffer(`${base}/analyze`, post);
    expect(required.accepts[0]!.amount).toBe('10000');
    for (const over of [{ amount: '1000' }, { payTo: accounts.stranger.address }]) {
      const payload = await paymentFor(required, {}, accounts.payer, over);
      const res = await pay(`${base}/analyze`, payload, post);
      expect(res.status, JSON.stringify(over)).toBe(402);
      expect(facilitator.calls, JSON.stringify(over)).toHaveLength(0);
    }
    expect(served).toBe(0);
  });

  it('400 on a malformed payment header', async () => {
    const res = await fetch(`${base}/predict`, { headers: { 'PAYMENT-SIGNATURE': 'not base64 json' } });
    expect(res.status).toBe(402);
    expect(served).toBe(0);
  });

  it('passes the facilitator refusal through as the 402 error and frees the claim', async () => {
    facilitator.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/predict`, payload);
    expect(res.status).toBe(402);
    expect(refusalReason(res)).toBe('invalid_exact_evm_insufficient_balance');
    expect(readSettlement(res)).toBeUndefined();
    expect(served).toBe(0);
    facilitator.mode = { kind: 'ok' };
    expect((await pay(`${base}/predict`, payload)).status).toBe(200); // the claim was released
  });

  it('does not settle when the handler fails, and the authorization can be reused', async () => {
    handlerStatus = 500;
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/predict`, payload);
    expect(res.status).toBe(500);
    expect(readSettlement(res)).toBeUndefined();
    expect(facilitator.calls.map((c) => c.route)).toEqual(['verify']);
    expect(settledEvents).toEqual([]);
    handlerStatus = 200;
    facilitator.calls.length = 0;
    expect((await pay(`${base}/predict`, payload)).status).toBe(200);
  });

  it('answers 402 when settlement fails after the handler ran, and frees the claim', async () => {
    facilitator.mode = { kind: 'settle-fail', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/predict`, payload);
    expect(res.status).toBe(402);
    expect(served).toBe(1); // the handler had already run: the authorization flow's known cost
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_transaction_failed' });
    expect(paywall.store.has(keyOf(payload))).toBe(false);
  });

  it('answers 402 settlement_unavailable when the facilitator is unreachable, errors, or times out; the claim is freed', async () => {
    const { required } = await getOffer(`${base}/predict`);
    for (const mode of [{ kind: 'down' }, { kind: 'http-500' }, { kind: 'slow', ms: 900 }] as const) {
      facilitator.mode = mode;
      facilitator.calls.length = 0;
      const payload = await paymentFor(required);
      const res = await pay(`${base}/predict`, payload);
      expect(res.status, mode.kind).toBe(402);
      expect(refusalReason(res), mode.kind).toBe('settlement_unavailable');
      expect(served, mode.kind).toBe(0);
      expect(paywall.store.has(keyOf(payload)), mode.kind).toBe(false);
    }
  });

  it("passes a facilitator's own 5xx reason through (an RPC outage behind it)", async () => {
    facilitator.mode = { kind: 'http-503-reason' };
    const { required } = await getOffer(`${base}/predict`);
    const res = await pay(`${base}/predict`, await paymentFor(required));
    expect(res.status).toBe(402);
    expect(refusalReason(res)).toBe('unexpected_verify_error');
  });

  it('a settle that the facilitator could not complete answers 402 with the failure in PAYMENT-RESPONSE', async () => {
    facilitator.mode = { kind: 'settle-down' };
    const { required } = await getOffer(`${base}/predict`);
    const res = await pay(`${base}/predict`, await paymentFor(required));
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'settlement_unavailable' });
    expect(served).toBe(1);
  });

  it('a settlement_pending answer (broadcast, no receipt yet) is passed through so the payer can reconcile', async () => {
    facilitator.mode = { kind: 'settle-pending' };
    const { required } = await getOffer(`${base}/predict`);
    const res = await pay(`${base}/predict`, await paymentFor(required));
    expect(res.status).toBe(402);
    const s = readSettlement(res);
    expect(s).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(s!.transaction).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('shares one in-flight store across routes and accepts an injected one', async () => {
    const store = new InMemoryIdempotencyStore();
    const p = createPaywall({
      facilitator: { url: facilitator.url },
      network: NETWORK,
      asset: USDC,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: accounts.payee.address,
      idempotencyStore: store,
      log: () => {},
    });
    expect(p.store).toBe(store);
    expect(paywall.store).toBe(paywall.store);
  });

  it('validates its construction', () => {
    const good = { facilitator: { url: facilitator.url }, network: NETWORK, asset: USDC, assetDomain: { ...MOCK_USDC_DOMAIN }, payTo: accounts.payee.address };
    expect(() => createPaywall({ ...good, asset: '0x1' as never })).toThrow(/asset/);
    expect(() => createPaywall({ ...good, payTo: 'nope' as never })).toThrow(/payTo/);
    expect(() => createPaywall({ ...good, network: 'base-sepolia' })).toThrow(/network/);
    expect(() => createPaywall({ ...good, assetDomain: { name: '', version: '2' } })).toThrow(/assetDomain/);
    expect(() => createPaywall({ ...good, facilitator: { url: 'ftp://x' } })).toThrow(/facilitator.url/);
    expect(() => createPaywall({ ...good, maxTimeoutSeconds: 0 })).toThrow(/maxTimeoutSeconds/);
    expect(() => createPaywall(good).charge('$0')).toThrow();
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('claims once, releases, retains until expiry, and sweeps expired entries', () => {
    const s = new InMemoryIdempotencyStore();
    expect(s.claim('A:1', 60, 1000)).toBe(true);
    expect(s.claim('a:1', 60, 1000)).toBe(false); // case-insensitive
    s.release('A:1');
    expect(s.claim('A:1', 60, 1000)).toBe(true);
    s.retain('A:1', 10, 1000);
    expect(s.claim('A:1', 60, 1005)).toBe(false);
    expect(s.claim('A:1', 60, 1011)).toBe(true); // expired retention no longer blocks
    for (let i = 0; i < 300; i++) s.claim(`B:${i}`, 1, 2000 + i); // each entry expires a second after the next claim
    expect(s.size).toBeLessThan(300); // the sweep ran during the flood and dropped the expired ones
  });
});

describe('createPaywall: settle serialisation and the one retry (offline, stub facilitator)', () => {
  let facilitator: StubFacilitator;
  let server: Server;
  let base: string;
  let settledEvents: Array<{ transaction: string; payer?: string }> = [];
  const chain = { used: false as boolean | undefined, reads: 0 };
  // A ChainReader double: `used` is what the chain answers, undefined makes the read fail.
  const chainReader = {
    authorizationUsed: async () => {
      chain.reads++;
      if (chain.used === undefined) throw new Error('rpc down');
      return chain.used;
    },
  };
  const baseOptions = () => ({
    facilitator: { url: facilitator.url, timeoutMs: 2000 },
    network: NETWORK,
    asset: USDC,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    payTo: accounts.payee.address,
    settleRetryDelayMs: 10,
    log: () => {},
  });
  let retrying: Paywall;

  beforeAll(async () => {
    facilitator = await startStubFacilitator({ network: NETWORK, address: accounts.facilitator.address });
    retrying = createPaywall({ ...baseOptions(), chainReader, onSettled: (r) => settledEvents.push({ transaction: r.transaction, payer: r.payer }) });
    const app = express();
    // Two paywalls on the same facilitator URL share one settle queue; a third opts out.
    app.get('/a', createPaywall(baseOptions()).charge('$0.001'), (_req, res) => res.json({ route: 'a' }));
    app.get('/b', createPaywall(baseOptions()).charge('$0.001'), (_req, res) => res.json({ route: 'b' }));
    app.get('/parallel', createPaywall({ ...baseOptions(), serializeSettle: false }).charge('$0.001'), (_req, res) => res.json({ route: 'parallel' }));
    app.get('/retry', retrying.charge('$0.001'), (_req, res) => res.json({ route: 'retry' }));
    app.get('/noreader', createPaywall(baseOptions()).charge('$0.001'), (_req, res) => res.json({ route: 'noreader' }));
    ({ server, base } = await listen(app));
  });

  afterAll(async () => {
    await closeServer(server);
    await facilitator.close();
  });

  afterEach(() => {
    facilitator.mode = { kind: 'ok' };
    facilitator.calls.length = 0;
    facilitator.maxConcurrentSettles = 0;
    settledEvents = [];
    chain.used = false;
    chain.reads = 0;
  });

  const settleCalls = () => facilitator.calls.filter((c) => c.route === 'settle').length;

  async function payConcurrently(paths: string[]): Promise<Response[]> {
    const payloads = await Promise.all(paths.map(async (p) => paymentFor((await getOffer(`${base}${p}`)).required)));
    return Promise.all(paths.map((p, i) => pay(`${base}${p}`, payloads[i]!)));
  }

  it('settles three concurrent payments one at a time (verify stays concurrent)', async () => {
    facilitator.mode = { kind: 'slow-settle', ms: 60 };
    const results = await payConcurrently(['/a', '/a', '/a']);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(settleCalls()).toBe(3);
    expect(facilitator.maxConcurrentSettles).toBe(1);
  });

  it('two paywalls on the same facilitator URL share one settle queue', async () => {
    facilitator.mode = { kind: 'slow-settle', ms: 60 };
    const results = await payConcurrently(['/a', '/b', '/a', '/b']);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(facilitator.maxConcurrentSettles).toBe(1);
  });

  it('serializeSettle: false lets settles overlap', async () => {
    facilitator.mode = { kind: 'slow-settle', ms: 120 };
    const results = await payConcurrently(['/parallel', '/parallel', '/parallel']);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(facilitator.maxConcurrentSettles).toBe(3);
  });

  it('retries a transaction_failed settle once when the chain says the authorization is unused, then serves', async () => {
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/retry`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/retry`, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ route: 'retry' });
    const settlement = readSettlement(res);
    expect(settlement).toMatchObject({ success: true, payer: accounts.payer.address });
    expect(facilitator.calls.map((c) => c.route)).toEqual(['verify', 'settle', 'settle']);
    expect(chain.reads).toBe(1);
    expect(settledEvents).toEqual([{ transaction: settlement!.transaction, payer: accounts.payer.address }]);
    expect(retrying.store.has(keyOf(payload))).toBe(true); // retained: the replay path is unchanged
    const again = await pay(`${base}/retry`, payload);
    expect(again.status).toBe(402);
    expect(refusalReason(again)).toBe('replay');
  });

  it('does not retry when the chain says the authorization was used', async () => {
    chain.used = true;
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/retry`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/retry`, payload);
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_transaction_failed' });
    expect(settleCalls()).toBe(1);
    expect(chain.reads).toBe(1);
    expect(settledEvents).toEqual([]);
    expect(retrying.store.has(keyOf(payload))).toBe(false);
  });

  it('does not retry when the chain cannot be read', async () => {
    chain.used = undefined;
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/retry`);
    const res = await pay(`${base}/retry`, await paymentFor(required));
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_transaction_failed' });
    expect(settleCalls()).toBe(1);
  });

  it('does not retry another failure reason', async () => {
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_insufficient_balance' };
    const { required } = await getOffer(`${base}/retry`);
    const res = await pay(`${base}/retry`, await paymentFor(required));
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_insufficient_balance' });
    expect(settleCalls()).toBe(1);
    expect(chain.reads).toBe(0);
  });

  it('does not retry without a chain reader', async () => {
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/noreader`);
    const res = await pay(`${base}/noreader`, await paymentFor(required));
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_transaction_failed' });
    expect(settleCalls()).toBe(1);
    expect(chain.reads).toBe(0);
  });

  it('retries an authorization only once, even when it is presented again', async () => {
    facilitator.mode = { kind: 'settle-fail', reason: 'invalid_exact_evm_transaction_failed' };
    const { required } = await getOffer(`${base}/retry`);
    const payload = await paymentFor(required);
    const first = await pay(`${base}/retry`, payload);
    expect(first.status).toBe(402);
    expect(settleCalls()).toBe(2);
    const second = await pay(`${base}/retry`, payload); // the claim was released, the retry was spent
    expect(second.status).toBe(402);
    expect(readSettlement(second)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_transaction_failed' });
    expect(settleCalls()).toBe(3);
    expect(chain.reads).toBe(1);
  });

  it('a failed retry surfaces the second reason and releases the claim', async () => {
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed', then: 'invalid_exact_evm_nonce_already_used' };
    const { required } = await getOffer(`${base}/retry`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/retry`, payload);
    expect(res.status).toBe(402);
    expect(readSettlement(res)).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_nonce_already_used' });
    expect(facilitator.calls.map((c) => c.route)).toEqual(['verify', 'settle', 'settle']);
    expect(settledEvents).toEqual([]);
    expect(retrying.store.has(keyOf(payload))).toBe(false);
  });

  it('holds the claim while the retry is in flight', async () => {
    facilitator.mode = { kind: 'settle-fail-once', reason: 'invalid_exact_evm_transaction_failed' };
    const slow = createPaywall({ ...baseOptions(), chainReader, settleRetryDelayMs: 150 });
    const app = express();
    app.get('/slow', slow.charge('$0.001'), (_req, res) => res.json({}));
    const { server: s2, base: b2 } = await listen(app);
    try {
      const { required } = await getOffer(`${b2}/slow`);
      const payload = await paymentFor(required);
      const first = pay(`${b2}/slow`, payload);
      await new Promise((r) => setTimeout(r, 80)); // inside the retry delay
      const second = await pay(`${b2}/slow`, payload);
      expect(second.status).toBe(402);
      expect(refusalReason(second)).toBe('replay');
      expect((await first).status).toBe(200);
      expect(facilitator.calls.map((c) => c.route)).toEqual(['verify', 'settle', 'settle']);
    } finally {
      await closeServer(s2);
    }
  });

  it('validates rpcUrl and settleRetryDelayMs', () => {
    expect(() => createPaywall({ ...baseOptions(), settleRetryDelayMs: -1 })).toThrow(/settleRetryDelayMs/);
    expect(() => createPaywall({ ...baseOptions(), rpcUrl: 'ws://x' })).toThrow(/rpcUrl/);
  });
});
