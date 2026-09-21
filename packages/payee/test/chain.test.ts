/**
 * End to end on a real chain: our paywall in front of express, the real
 * @agentpay/facilitator in-process, MockUSDC on hardhat :8548 — paid by a
 * hand-signed authorization and by the official @x402/fetch client.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createPublicClient, http } from 'viem';
import { hardhat } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { EIP3009_ABI } from '@agentpay/core';
import { createFacilitator, type FacilitatorHandle } from '@agentpay/facilitator';
import { createChainReader, createPaywall } from '../src/index.js';
import { KEYS, accounts, closeServer, getOffer, listen, pay, paymentFor, readSettlement, refusalReason } from './helpers.js';

const skipReason = inject('skipReason');

describe.skipIf(skipReason)('paywall + facilitator on hardhat', () => {
  const rpcUrl = inject('rpcUrl');
  const usdc = inject('usdc');
  const publicClient = createPublicClient({ chain: hardhat, transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 50 });
  let facilitator: FacilitatorHandle;
  let server: Server;
  let base: string;
  let served = 0;

  const balanceOf = (who: `0x${string}`) =>
    publicClient.readContract({ address: usdc, abi: EIP3009_ABI, functionName: 'balanceOf', args: [who] });

  beforeAll(async () => {
    facilitator = createFacilitator({
      rpcUrl,
      chainId: hardhat.id,
      key: KEYS.facilitator,
      tokens: [usdc],
      assetDomain: { ...MOCK_USDC_DOMAIN },
      port: 0,
      pollingIntervalMs: 50,
      log: () => {},
    });
    await facilitator.start();
    const paywall = createPaywall({
      facilitator: { url: facilitator.url },
      network: `eip155:${hardhat.id}`,
      asset: usdc,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: accounts.payee.address,
      rpcUrl, // the retry gate reads authorizationState here
      log: () => {},
    });
    const app = express();
    app.get('/predict', paywall.charge('$0.001'), (_req, res) => {
      served++;
      res.json({ price: 3000 });
    });
    ({ server, base } = await listen(app));
  });

  afterAll(async () => {
    await closeServer(server);
    await facilitator.stop();
  });

  it('serves a funded payer and moves 1000 atomic USDC on chain before the response goes out', async () => {
    const payerBefore = await balanceOf(accounts.payer.address);
    const payeeBefore = await balanceOf(accounts.payee.address);
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const res = await pay(`${base}/predict`, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: 3000 });
    const settlement = readSettlement(res)!;
    expect(settlement).toMatchObject({ success: true, payer: accounts.payer.address, network: `eip155:${hardhat.id}` });
    const receipt = await publicClient.getTransactionReceipt({ hash: settlement.transaction as `0x${string}` });
    expect(receipt.status).toBe('success');
    expect(await balanceOf(accounts.payer.address)).toBe(payerBefore - 1000n);
    expect(await balanceOf(accounts.payee.address)).toBe(payeeBefore + 1000n);
    expect(served).toBe(1);
  });

  it('refuses an unfunded payer with the facilitator reason and serves nothing', async () => {
    const before = served;
    const { required } = await getOffer(`${base}/predict`);
    const res = await pay(`${base}/predict`, await paymentFor(required, {}, accounts.stranger));
    expect(res.status).toBe(402);
    expect(refusalReason(res)).toBe('invalid_exact_evm_insufficient_balance');
    expect(served).toBe(before);
  });

  it('refuses a replay after settlement (locally, and on chain if presented elsewhere)', async () => {
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    expect((await pay(`${base}/predict`, payload)).status).toBe(200);
    const again = await pay(`${base}/predict`, payload);
    expect(again.status).toBe(402);
    expect(refusalReason(again)).toBe('replay');
    const a = (payload.payload as { authorization: { from: `0x${string}`; nonce: `0x${string}` } }).authorization;
    expect(
      await publicClient.readContract({ address: usdc, abi: EIP3009_ABI, functionName: 'authorizationState', args: [a.from, a.nonce] }),
    ).toBe(true);
  });

  it('createChainReader reads authorizationState on the real chain: used after settlement, unused for a fresh nonce', async () => {
    const reader = createChainReader(rpcUrl);
    const { required } = await getOffer(`${base}/predict`);
    const payload = await paymentFor(required);
    const a = (payload.payload as { authorization: { from: `0x${string}`; nonce: `0x${string}` } }).authorization;
    expect(await reader.authorizationUsed(usdc, a.from, a.nonce)).toBe(false);
    expect((await pay(`${base}/predict`, payload)).status).toBe(200);
    expect(await reader.authorizationUsed(usdc, a.from, a.nonce)).toBe(true);
    await expect(createChainReader('http://127.0.0.1:1', { timeoutMs: 500 }).authorizationUsed(usdc, a.from, a.nonce)).rejects.toThrow();
  });

  it('is paid by the official @x402/fetch client', async () => {
    const before = served;
    const payerBefore = await balanceOf(accounts.payer.address);
    const client = new x402Client().setSpendControls(false); // MockUSDC is not a default asset
    registerExactEvmScheme(client, { signer: accounts.payer });
    const paidFetch = wrapFetchWithPayment(fetch, client);
    const res = await paidFetch(`${base}/predict`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: 3000 });
    const settlement = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE')!);
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await balanceOf(accounts.payer.address)).toBe(payerBefore - 1000n);
    expect(served).toBe(before + 1);
  });
});
