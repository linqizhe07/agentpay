import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FacilitatorHandle } from '../src/index.js';
import {
  AMOUNT,
  accounts,
  extraAccount,
  fixture,
  get,
  mkFacilitator,
  nowSec,
  requirements,
  settle,
  signedPayment,
  verify,
} from './helpers.js';

describe('POST /verify', () => {
  let fac: FacilitatorHandle;

  beforeAll(async () => {
    fac = mkFacilitator();
    await fac.start();
  });
  afterAll(async () => {
    await fac.stop();
  });

  it('accepts a well-formed, funded authorization and names the payer', async () => {
    const r = await verify(fac, await signedPayment());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ isValid: true, invalidReason: undefined, payer: accounts.payer.address });
  });

  it('GET /supported advertises exact on this chain and this signer', async () => {
    const r = await get(`${fac.url}/supported`);
    expect(r.status).toBe(200);
    expect(r.json.kinds).toEqual([{ x402Version: 2, scheme: 'exact', network: `eip155:${fixture().chainId}`, extra: undefined }]);
    expect(r.json.signers['eip155:*']).toEqual([fac.address]);
    expect(Array.isArray(r.json.extensions)).toBe(true);
  });

  it('rejects a signature from anyone but `from`', async () => {
    const s = await signedPayment(requirements(), { from: accounts.payer.address }, accounts.stranger);
    const r = await verify(fac, s);
    expect(r.json.isValid).toBe(false);
    expect(r.json.invalidReason).toBe('invalid_exact_evm_signature');
  });

  it('rejects a recipient other than payTo', async () => {
    const s = await signedPayment(requirements(), { to: accounts.stranger.address });
    expect((await verify(fac, s)).json.invalidReason).toBe('invalid_exact_evm_recipient_mismatch');
  });

  it('rejects a value that differs from the amount (exact means exact)', async () => {
    const s = await signedPayment(requirements(), { value: (AMOUNT + 1n).toString() });
    expect((await verify(fac, s)).json.invalidReason).toBe('invalid_exact_evm_payload_authorization_value_mismatch');
  });

  it('rejects an authorization that expires within the settlement margin', async () => {
    const s = await signedPayment(requirements(), { validBefore: String(nowSec() + 3) });
    expect((await verify(fac, s)).json.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_before');
  });

  it('rejects an authorization that is not valid yet', async () => {
    const s = await signedPayment(requirements(), { validAfter: String(nowSec() + 3600) });
    expect((await verify(fac, s)).json.invalidReason).toBe('invalid_exact_evm_payload_authorization_valid_after');
  });

  it('rejects an unfunded payer with the precise reason (Multicall3 diagnostics)', async () => {
    const broke = extraAccount(11);
    const s = await signedPayment(requirements(), {}, broke);
    const r = await verify(fac, s);
    expect(r.json).toMatchObject({ isValid: false, invalidReason: 'invalid_exact_evm_insufficient_balance', payer: broke.address });
  });

  it('rejects an authorization whose nonce was already settled', async () => {
    const s = await signedPayment();
    expect((await settle(fac, s)).json.success).toBe(true);
    expect((await verify(fac, s)).json.invalidReason).toBe('invalid_exact_evm_nonce_already_used');
  });

  it('refuses requirements this facilitator does not serve before touching the chain', async () => {
    const s = await signedPayment();
    const cases: Array<[Partial<Parameters<typeof requirements>[0]>, string]> = [
      [{ scheme: 'upto' }, 'unsupported_scheme'],
      [{ network: 'eip155:84532' }, 'invalid_network'],
      [{ asset: accounts.stranger.address }, 'unsupported_asset'],
    ];
    for (const [over, reason] of cases) {
      const r = await verify(fac, s, requirements(over));
      expect(r.status, reason).toBe(200);
      expect(r.json, reason).toEqual({ isValid: false, invalidReason: reason });
    }
  });

  it('refuses the payer/facilitator network mismatch the official scheme checks', async () => {
    const s = await signedPayment(requirements({ network: 'eip155:84532' }));
    // The facilitator serves 31337; the requirements the payee forwards say so, but the payer accepted 84532.
    const r = await verify(fac, s, requirements());
    expect(r.json.invalidReason).toBe('invalid_exact_evm_network_mismatch');
  });

  it('refuses a payee outside the PAYEES allowlist when one is configured', async () => {
    const gated = mkFacilitator({ payees: [accounts.stranger.address] });
    await gated.start();
    try {
      const r = await verify(gated, await signedPayment());
      expect(r.json).toEqual({ isValid: false, invalidReason: 'unsupported_payee' });
      const ok = await verify(gated, await signedPayment(requirements({ payTo: accounts.stranger.address })));
      expect(ok.json.isValid).toBe(true);
    } finally {
      await gated.stop();
    }
  });
});
