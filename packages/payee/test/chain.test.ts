import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { createPublicClient, createWalletClient, http } from 'viem';
import { hardhat } from 'viem/chains';
import { AEP2_DEBIT_WALLET_ABI } from '@agentpay/contracts';
import { mandateToTuple, verifySpReceipt, type Address, type MandateDomain, type PaymentRequiredBody } from '@agentpay/core';
import { createMandatePaywall, type MandatePaywallOptions } from '../src/index.js';
import { startStubSp, type StubSp } from './stub-sp.js';
import { KEYS, accounts, call, closeServer, getOffer, listen, nowSec, readSettlement, signFor, x402Header } from './helpers.js';

// Only ever non-empty for the explicit AGENTPAY_SKIP_CHAIN_TESTS=1 opt-out;
// environment failures throw in global-setup instead of skipping.
const skipReason = inject('skipReason');
const SETTLE_WINDOW = 120;

describe.skipIf(!!skipReason)('createMandatePaywall on-chain pre-checks (hardhat node :8548)', () => {
  let usdc: Address;
  let wallet: Address;
  let rpcUrl: string;
  let domain: MandateDomain;
  let stub: StubSp;
  let server: Server;
  let base: string;
  let pub: ReturnType<typeof createPublicClient>;
  const served = { predict: 0, analyze: 0 };

  const debitable = (owner: Address): Promise<bigint> =>
    pub.readContract({ address: wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName: 'debitableBalance', args: [owner, usdc] });
  const nonceUsed = (owner: Address, nonce: string): Promise<boolean> =>
    pub.readContract({ address: wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName: 'usedNonces', args: [owner, BigInt(nonce)] });

  beforeAll(async () => {
    usdc = inject('usdc');
    wallet = inject('wallet');
    rpcUrl = inject('rpcUrl');
    domain = { chainId: 31337, verifyingContract: wallet };
    pub = createPublicClient({ chain: hardhat, transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 50 });
    stub = await startStubSp({ key: KEYS.sp, domain, settleWindowSeconds: SETTLE_WINDOW });

    const common: Omit<MandatePaywallOptions, 'price'> = {
      network: 'eip155:31337',
      asset: usdc,
      payTo: accounts.payee.address,
      wallet,
      sp: { url: stub.url, address: stub.address, settleWindowSeconds: SETTLE_WINDOW },
    };
    const app = express();
    app.use(express.json());
    // rpcUrl only: verifyOnChain defaults to true on eip155:31337 with an RPC source
    app.get('/predict', createMandatePaywall({ ...common, price: '$0.001', rpcUrl }), (_req, res) => {
      served.predict += 1;
      res.json({ symbol: 'ETH-USD', price: 1 });
    });
    // explicit publicClient path
    app.post('/analyze', createMandatePaywall({ ...common, price: '$0.01', verifyOnChain: true, publicClient: pub }), (req, res) => {
      served.analyze += 1;
      res.json({ ok: true, echo: req.body });
    });
    ({ server, base } = await listen(app));
  });

  afterAll(async () => {
    await closeServer(server);
    await stub?.close();
  });

  it('serves a funded payer and moves nothing on-chain during the request', async () => {
    const offer = await getOffer(base, '/predict');
    expect(offer.extra.wallet).toBe(wallet);
    const before = await debitable(accounts.payer.address);
    expect(before).toBeGreaterThan(0n);

    const signed = await signFor(domain, offer);
    const res = await call(base, '/predict', { header: x402Header(offer, signed.payload) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ symbol: 'ETH-USD', price: 1 });
    expect(served.predict).toBe(1);

    const info = readSettlement(res);
    expect(info.mandateDigest).toBe(signed.digest);
    expect(info.payer).toBe(accounts.payer.address);
    expect(
      await verifySpReceipt(info.spReceipt, {
        domain,
        expectedSp: stub.address,
        mandateDigest: signed.digest,
        mandateDeadline: signed.mandate.deadline,
        now: nowSec(),
        maxWindowSeconds: SETTLE_WINDOW + 60,
      }),
    ).toEqual({ ok: true });
    expect(stub.calls[stub.calls.length - 1]).toEqual(signed.payload);

    // settlement is deferred: balance and nonce are untouched
    expect(await debitable(accounts.payer.address)).toBe(before);
    expect(await nonceUsed(accounts.payer.address, signed.mandate.nonce)).toBe(false);
  });

  it('refuses a stranger with no deposit with insufficient_balance before contacting the SP', async () => {
    const offer = await getOffer(base, '/predict');
    const served0 = served.predict;
    const calls0 = stub.calls.length;
    expect(await debitable(accounts.stranger.address)).toBe(0n);

    const signed = await signFor(domain, offer, {}, accounts.stranger);
    const header = x402Header(offer, signed.payload);
    for (let i = 0; i < 2; i++) {
      // second attempt proves the claim was released (402 again, not 409)
      const res = await call(base, '/predict', { header });
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequiredBody;
      expect(body.error).toMatch(/^insufficient_balance/);
      expect(body.payment_model_context?.reason).toBe('insufficient_balance');
    }
    expect(served.predict).toBe(served0);
    expect(stub.calls).toHaveLength(calls0);
  });

  it('refuses a mandate whose nonce was already settled out-of-band with nonce_used', async () => {
    const offer = await getOffer(base, '/analyze', 'POST');
    const served0 = served.analyze;
    const calls0 = stub.calls.length;
    const signed = await signFor(domain, offer);

    // The SP settles the mandate directly (payer authorized SP #3 in the fixture).
    const spWallet = createWalletClient({ account: accounts.sp, chain: hardhat, transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 50 });
    const hash = await spWallet.writeContract({
      address: wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settle',
      args: [mandateToTuple(signed.mandate), signed.payerSig],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(await nonceUsed(accounts.payer.address, signed.mandate.nonce)).toBe(true);

    const header = x402Header(offer, signed.payload);
    for (let i = 0; i < 2; i++) {
      const res = await call(base, '/analyze', { method: 'POST', header, body: { text: 'again' } });
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequiredBody;
      expect(body.error).toMatch(/^nonce_used/);
      expect(body.payment_model_context?.reason).toBe('nonce_used');
    }
    expect(served.analyze).toBe(served0);
    expect(stub.calls).toHaveLength(calls0);

    // a fresh mandate from the same payer still goes through
    const fresh = await signFor(domain, offer);
    const ok = await call(base, '/analyze', { method: 'POST', header: x402Header(offer, fresh.payload), body: { text: 'fresh' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, echo: { text: 'fresh' } });
    expect(served.analyze).toBe(served0 + 1);
  });
});
