import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FacilitatorHandle } from '../src/index.js';
import { MAX_BODY_BYTES } from '../src/index.js';
import { facilitatorBody, get, mkFacilitator, post, signedPayment, verify } from './helpers.js';

describe('http surface', () => {
  let fac: FacilitatorHandle;

  beforeAll(async () => {
    fac = mkFacilitator();
    await fac.start();
  });
  afterAll(async () => {
    await fac.stop();
  });

  it('GET /health reports the signer, chain and gas balance', async () => {
    const r = await get(`${fac.url}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, address: fac.address, chainId: 31337, network: 'eip155:31337', rpcOk: true, payees: 'any' });
    expect(BigInt(r.json.ethBalance)).toBeGreaterThan(0n);
    expect(r.json.tokens[0]).toMatchObject({ symbol: 'USDC', decimals: 6 });
  });

  it('400 invalid_body for non-JSON, wrong shapes and missing parts', async () => {
    const s = await signedPayment();
    const bad: Array<[unknown, boolean]> = [
      ['not json', true],
      [[], false],
      [{}, false],
      [{ x402Version: 2, paymentPayload: s.payload }, false],
      [{ x402Version: 2, paymentPayload: { x402Version: 2 }, paymentRequirements: s.requirements }, false],
      [{ x402Version: 2, paymentPayload: s.payload, paymentRequirements: { scheme: 'exact' } }, false],
    ];
    for (const [body, raw] of bad) {
      for (const route of ['verify', 'settle']) {
        const r = await post(`${fac.url}/${route}`, body, { raw });
        expect(r.status, `${route} ${JSON.stringify(body)}`).toBe(400);
        expect(r.json.error).toBe('invalid_body');
      }
    }
  });

  it('answers invalid_x402_version for a V1 envelope without touching the chain', async () => {
    const s = await signedPayment();
    const r = await post(`${fac.url}/verify`, { ...facilitatorBody(s), x402Version: 1 });
    expect(r.json).toEqual({ isValid: false, invalidReason: 'invalid_x402_version' });
  });

  it('413 for oversized bodies', async () => {
    const r = await post(`${fac.url}/verify`, `{"pad":"${'x'.repeat(MAX_BODY_BYTES + 1)}"}`, { raw: true });
    expect(r.status).toBe(413);
    expect(r.json.error).toBe('payload_too_large');
  });

  it('404 for unknown routes and 405 for wrong methods', async () => {
    expect((await get(`${fac.url}/enqueue`)).status).toBe(404);
    const r = await get(`${fac.url}/verify`);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
    expect((await post(`${fac.url}/supported`, {})).status).toBe(405);
  });

  it('requires the bearer token on /verify and /settle when one is configured', async () => {
    const guarded = mkFacilitator({ authToken: 's3cret' });
    await guarded.start();
    try {
      const s = await signedPayment();
      const anon = await verify(guarded, s);
      expect(anon.status).toBe(401);
      expect(anon.headers.get('www-authenticate')).toBe('Bearer');
      const wrong = await post(`${guarded.url}/verify`, facilitatorBody(s), { headers: { authorization: 'Bearer nope' } });
      expect(wrong.status).toBe(401);
      const ok = await post(`${guarded.url}/verify`, facilitatorBody(s), { headers: { authorization: 'Bearer s3cret' } });
      expect(ok.status).toBe(200);
      expect(ok.json.isValid).toBe(true);
      expect((await get(`${guarded.url}/supported`)).status).toBe(200); // discovery stays open
    } finally {
      await guarded.stop();
    }
  });
});
