import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySpReceipt, type Address, type Hex, type MandateDomain, type PaymentRequirements } from '@agentpay/core';
import { InMemoryIdempotencyStore, SpClient, SpError } from '../src/index.js';
import { startStubSp, type StubSp } from './stub-sp.js';
import { KEYS, accounts, nowSec, signFor } from './helpers.js';

const WALLET = '0x1000000000000000000000000000000000000001' as Address;
const USDC = '0x2000000000000000000000000000000000000002' as Address;
const domain: MandateDomain = { chainId: 31337, verifyingContract: WALLET };
const SETTLE_WINDOW = 120;

const offer: PaymentRequirements = {
  scheme: 'aep2',
  network: 'eip155:31337',
  amount: '1000',
  asset: USDC,
  payTo: accounts.payee.address,
  resource: 'GET /predict',
  maxTimeoutSeconds: 60,
  extra: { wallet: WALLET, sp: '', spAddress: accounts.sp.address, settleWindowSeconds: SETTLE_WINDOW },
};

describe('SpClient', () => {
  let stub: StubSp;
  let client: SpClient;

  beforeAll(async () => {
    stub = await startStubSp({ key: KEYS.sp, domain, settleWindowSeconds: SETTLE_WINDOW, slowMs: 1500 });
    client = new SpClient({ url: `${stub.url}/`, timeoutMs: 400 }); // trailing slash is tolerated
  });

  afterAll(async () => {
    await stub.close();
  });

  it('enqueue returns the receipt the SP signed', async () => {
    const signed = await signFor(domain, offer);
    const { receipt, created } = await client.enqueue(signed.payload);
    expect(created).toBe(true);
    expect(receipt.sp).toBe(stub.address);
    expect(receipt.mandateDigest).toBe(signed.digest);
    expect(receipt.enqueueDeadline).toBeLessThanOrEqual(nowSec() + SETTLE_WINDOW + 1);
    expect(await verifySpReceipt(receipt, { domain, expectedSp: stub.address, mandateDigest: signed.digest, now: nowSec() })).toEqual({ ok: true });
    expect(stub.calls[stub.calls.length - 1]).toEqual(signed.payload);

    // GET helpers
    expect(await client.status(signed.digest)).toMatchObject({ status: 'pending' });
    expect(await client.supported()).toMatchObject({ sp: stub.address, settleWindowSeconds: SETTLE_WINDOW, chainId: 31337 });
    expect(await client.health()).toMatchObject({ ok: true });
  });

  it('throws SpError carrying the SP code, HTTP status and body on refusal', async () => {
    const signed = await signFor(domain, offer);
    stub.mode = 'reject';
    stub.rejectCode = 'insufficient_balance';
    stub.rejectStatus = 402;
    const err = await client.enqueue(signed.payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpError);
    const spErr = err as SpError;
    expect(spErr.status).toBe(402);
    expect(spErr.reason).toBe('insufficient_balance');
    expect(spErr.body).toMatchObject({ success: false, error: 'insufficient_balance', mandateDigest: signed.digest });
    expect(spErr.message).toContain('insufficient_balance');
    stub.mode = 'ok';

    const unknown = await client.status(`0x${'ab'.repeat(32)}` as Hex).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(SpError);
    expect((unknown as SpError).status).toBe(404);
    expect((unknown as SpError).reason).toBe('not_found');
  });

  it('maps dropped connections, closed ports and timeouts to SpError status 0', async () => {
    const signed = await signFor(domain, offer);

    stub.mode = 'down';
    let err = (await client.enqueue(signed.payload).catch((e: unknown) => e)) as SpError;
    expect(err).toBeInstanceOf(SpError);
    expect(err.status).toBe(0);
    expect(err.reason).toBe('unreachable');

    stub.mode = 'slow';
    err = (await client.enqueue(signed.payload).catch((e: unknown) => e)) as SpError;
    expect(err).toBeInstanceOf(SpError);
    expect(err.status).toBe(0);
    expect(err.reason).toBe('timeout');
    stub.mode = 'ok';

    const nobody = new SpClient({ url: 'http://127.0.0.1:1', timeoutMs: 400 });
    err = (await nobody.health().catch((e: unknown) => e)) as SpError;
    expect(err).toBeInstanceOf(SpError);
    expect(err.reason).toBe('unreachable');
  });

  it('treats a 2xx without a receipt (or a non-JSON 5xx) as an error', async () => {
    const signed = await signFor(domain, offer);
    const fake = (body: string, status: number): typeof fetch => async () =>
      new Response(body, { status, headers: { 'content-type': status < 300 ? 'application/json' : 'text/html' } });

    let err = (await new SpClient({ url: 'http://sp' }, fake('{"success":true}', 200)).enqueue(signed.payload).catch((e: unknown) => e)) as SpError;
    expect(err).toBeInstanceOf(SpError);
    expect(err.reason).toBe('malformed_response');
    expect(err.status).toBe(200);

    err = (await new SpClient({ url: 'http://sp' }, fake('<h1>Bad Gateway</h1>', 502)).enqueue(signed.payload).catch((e: unknown) => e)) as SpError;
    expect(err).toBeInstanceOf(SpError);
    expect(err.status).toBe(502);
    expect(err.reason).toBe('http_502');
    expect(err.body).toBe('<h1>Bad Gateway</h1>');
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('claims once, is case-insensitive, and releases', () => {
    const store = new InMemoryIdempotencyStore();
    const digest = `0x${'AB'.repeat(32)}` as Hex;
    expect(store.has(digest)).toBe(false);
    expect(store.claim(digest)).toBe(true);
    expect(store.claim(digest)).toBe(false);
    expect(store.claim(digest.toLowerCase() as Hex)).toBe(false);
    expect(store.has(digest.toLowerCase() as Hex)).toBe(true);
    expect(store.size).toBe(1);
    store.release(digest.toLowerCase() as Hex);
    expect(store.has(digest)).toBe(false);
    expect(store.claim(digest)).toBe(true);
    store.release(`0x${'00'.repeat(32)}` as Hex); // releasing an unknown digest is a no-op
    expect(store.size).toBe(1);
  });
});
