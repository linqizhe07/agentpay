import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEventLogs } from 'viem';
import { EIP3009_ABI } from '@agentpay/core';
import type { FacilitatorHandle } from '../src/index.js';
import {
  AMOUNT,
  accounts,
  authorizationState,
  extraAccount,
  fixture,
  mkFacilitator,
  nowSec,
  publicClient,
  requirements,
  rpcProxy,
  settle,
  signedPayment,
  usdcBalance,
  waitFor,
} from './helpers.js';

const TX_RE = /^0x[0-9a-f]{64}$/;

describe('POST /settle', () => {
  let fac: FacilitatorHandle;

  beforeAll(async () => {
    fac = mkFacilitator();
    await fac.start();
  });
  afterAll(async () => {
    await fac.stop();
  });

  it('moves the value on chain in one transaction paid by the facilitator', async () => {
    const s = await signedPayment();
    const payerBefore = await usdcBalance(accounts.payer.address);
    const payeeBefore = await usdcBalance(accounts.payee.address);

    const r = await settle(fac, s);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, network: `eip155:${fixture().chainId}`, payer: accounts.payer.address });
    expect(r.json.transaction).toMatch(TX_RE);

    const receipt = await publicClient().getTransactionReceipt({ hash: r.json.transaction });
    expect(receipt.from.toLowerCase()).toBe(fac.address.toLowerCase());
    const used = parseEventLogs({ abi: EIP3009_ABI, eventName: 'AuthorizationUsed', logs: receipt.logs });
    expect(used[0]!.args).toEqual({ authorizer: accounts.payer.address, nonce: s.authorization.nonce });

    expect(await usdcBalance(accounts.payer.address)).toBe(payerBefore - AMOUNT);
    expect(await usdcBalance(accounts.payee.address)).toBe(payeeBefore + AMOUNT);
    expect(await authorizationState(accounts.payer.address, s.authorization.nonce)).toBe(true);
  });

  it('settles the same authorization only once', async () => {
    const s = await signedPayment();
    const first = await settle(fac, s);
    expect(first.json.success).toBe(true);
    const again = await settle(fac, s);
    expect(again.status).toBe(200);
    expect(again.json.success).toBe(false);
    expect(again.json.errorReason).toBe('invalid_exact_evm_nonce_already_used');
    expect(again.json.transaction).toBe('');
  });

  it('two concurrent settles of one authorization produce one transaction', async () => {
    const s = await signedPayment();
    const payeeBefore = await usdcBalance(accounts.payee.address);
    const [a, b] = await Promise.all([settle(fac, s), settle(fac, s)]);
    const results = [a.json, b.json];
    expect(results.filter((x) => x.success)).toHaveLength(1);
    expect(await usdcBalance(accounts.payee.address)).toBe(payeeBefore + AMOUNT);
  });

  it('settles a dozen different authorizations in parallel with sequential facilitator nonces', async () => {
    const n = 12;
    const payments = await Promise.all(Array.from({ length: n }, () => signedPayment()));
    const payeeBefore = await usdcBalance(accounts.payee.address);
    const nonceBefore = await publicClient().getTransactionCount({ address: fac.address });

    const replies = await Promise.all(payments.map((p) => settle(fac, p)));
    for (const r of replies) expect(r.json).toMatchObject({ success: true });
    const hashes = new Set(replies.map((r) => r.json.transaction as string));
    expect(hashes.size).toBe(n);
    for (const h of hashes) expect(h).toMatch(TX_RE);

    expect(await usdcBalance(accounts.payee.address)).toBe(payeeBefore + AMOUNT * BigInt(n));
    expect(await publicClient().getTransactionCount({ address: fac.address })).toBe(nonceBefore + n);
  });

  it('refuses without broadcasting when the authorization cannot be settled', async () => {
    const broke = extraAccount(12);
    const nonceBefore = await publicClient().getTransactionCount({ address: fac.address });
    const r = await settle(fac, await signedPayment(requirements(), {}, broke));
    expect(r.json).toMatchObject({ success: false, errorReason: 'invalid_exact_evm_insufficient_balance', transaction: '' });
    const expired = await settle(fac, await signedPayment(requirements(), { validBefore: String(nowSec() - 1) }));
    expect(expired.json.errorReason).toBe('invalid_exact_evm_payload_authorization_valid_before');
    expect(await publicClient().getTransactionCount({ address: fac.address })).toBe(nonceBefore);
  });

  it('refuses requirements this facilitator does not serve', async () => {
    const s = await signedPayment();
    const r = await settle(fac, s, requirements({ asset: accounts.stranger.address }));
    expect(r.json).toEqual({ success: false, errorReason: 'unsupported_asset', transaction: '', network: s.requirements.network });
  });

  it('answers 503 while the RPC is unreachable and settles once it is back', async () => {
    const proxy = await rpcProxy(fixture().rpcUrl);
    const flaky = mkFacilitator({ rpcUrl: proxy.url });
    await flaky.start();
    try {
      const s = await signedPayment();
      proxy.dead = true;
      const down = await settle(flaky, s);
      expect(down.status).toBe(503);
      expect(down.json).toMatchObject({ success: false, errorReason: 'unexpected_settle_error', transaction: '' });
      expect(down.headers.get('retry-after')).toBe('5');
      const health = await fetch(`${flaky.url}/health`);
      expect(health.status).toBe(503);

      proxy.dead = false;
      await waitFor(async () => (await fetch(`${flaky.url}/health`)).status === 200);
      const up = await settle(flaky, s);
      expect(up.json.success).toBe(true);
    } finally {
      await flaky.stop();
      await proxy.close();
    }
  });
});
