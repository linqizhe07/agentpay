/**
 * Chain-backed suite: hardhat on :8549 (see global-setup.ts), the real
 * @agentpay/facilitator and @agentpay/payee in-process. Skipped with
 * AGENTPAY_SKIP_CHAIN_TESTS=1. The time-travel test runs last: after it, chain
 * time is ahead of the wall clock every later authorization would be signed with.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, parseSignature, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { EIP3009_ABI } from '@agentpay/core';
import { createFacilitator, type FacilitatorHandle } from '@agentpay/facilitator';
import { createPaywall } from '@agentpay/payee';
import { Ledger, MandateWallet, type LedgerEntry } from '../src/index.js';
import type { ChainFixture } from './global-setup.js';
import { KEYS, startStubPayee, type StubPayee } from './stub-payee.js';

const SKIP = process.env.AGENTPAY_SKIP_CHAIN_TESTS === '1';
const NETWORK = 'eip155:31337';
const AMOUNT = 1000n;

describe.skipIf(SKIP)('MandateWallet on hardhat', () => {
  let fx: ChainFixture;
  let facilitator: FacilitatorHandle;
  let payeeServer: Server;
  let payeeUrl: string;
  let served = 0;
  const payer = privateKeyToAccount(KEYS.payer);
  const payee = privateKeyToAccount(KEYS.payee);
  const relayer = privateKeyToAccount(KEYS.stranger);
  let publicClient: ReturnType<typeof createPublicClient>;
  let testClient: ReturnType<typeof createTestClient>;
  const stubs: StubPayee[] = [];

  const usdcBalance = (who: Address) =>
    publicClient.readContract({ address: fx.usdc, abi: EIP3009_ABI, functionName: 'balanceOf', args: [who] });
  const authorizationState = (nonce: Hex) =>
    publicClient.readContract({ address: fx.usdc, abi: EIP3009_ABI, functionName: 'authorizationState', args: [payer.address, nonce] });
  const chainNow = async () => Number((await publicClient.getBlock()).timestamp);

  function makeWallet(over: Partial<ConstructorParameters<typeof MandateWallet>[0]> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'agentpay-wallet-chain-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const wallet = new MandateWallet({
      account: payer,
      rpcUrl: fx.rpcUrl,
      token: fx.usdc,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      network: NETWORK,
      mandatesPath: join(dir, 'mandates.json'),
      ledgerPath,
      ...over,
    });
    return { wallet, ledgerPath };
  }

  /** Anyone can relay a signed authorization: settle a ledger row's out of band. */
  async function relay(e: LedgerEntry): Promise<Hex> {
    const w = createWalletClient({ chain: hardhat, transport: http(fx.rpcUrl, { retryCount: 0 }), account: relayer, pollingInterval: 50 });
    const { v, r, s, yParity } = parseSignature(e.signature);
    const a = e.authorization;
    const hash = await w.writeContract({
      address: fx.usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? (yParity === 1 ? 28 : 27)), r, s],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  beforeAll(async () => {
    fx = inject('agentpayChain');
    const transport = http(fx.rpcUrl, { retryCount: 0 });
    publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
    testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport, pollingInterval: 50 });
    facilitator = createFacilitator({
      rpcUrl: fx.rpcUrl,
      chainId: hardhat.id,
      key: KEYS.facilitator,
      tokens: [fx.usdc],
      assetDomain: { ...MOCK_USDC_DOMAIN },
      port: 0,
      pollingIntervalMs: 50,
      log: () => {},
    });
    await facilitator.start();
    const paywall = createPaywall({
      facilitator: { url: facilitator.url },
      network: NETWORK,
      asset: fx.usdc,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: payee.address,
      log: () => {},
    });
    const app = express();
    app.get('/predict', paywall.charge('$0.001'), (_req, res) => {
      served++;
      res.json({ ok: true });
    });
    payeeServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => payeeServer.once('listening', () => r()));
    const addr = payeeServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    payeeUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => {
      payeeServer?.close(() => r());
      payeeServer?.closeAllConnections();
    });
    await facilitator?.stop();
    await Promise.all(stubs.map((s) => s.close()));
  });

  it('balance() reads the payer token balance', async () => {
    const { wallet } = makeWallet();
    expect(await wallet.balance()).toBe(await usdcBalance(payer.address));
    const warnings: string[] = [];
    const warned = makeWallet({ caps: { floatWarnAtomic: 1n }, log: (l) => warnings.push(l) });
    await warned.wallet.balance();
    expect(warnings.join('\n')).toMatch(/small float/);
  });

  it('pays through the real facilitator: value moves in the same call, the ledger has the transaction', async () => {
    const { wallet, ledgerPath } = makeWallet();
    const m = await wallet.createIntentMandate({ naturalLanguage: 'x', limitAmount: '$1', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] }, { approve: true });
    const payerBefore = await usdcBalance(payer.address);
    const payeeBefore = await usdcBalance(payee.address);
    const res = await wallet.fetch(`${payeeUrl}/predict`);
    expect(res.status).toBe(200);
    const [e] = new Ledger(ledgerPath).read();
    expect(e.status).toBe('settled');
    expect(e.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await usdcBalance(payer.address)).toBe(payerBefore - AMOUNT);
    expect(await usdcBalance(payee.address)).toBe(payeeBefore + AMOUNT);
    expect(await authorizationState(e.nonce)).toBe(true);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
    expect(served).toBe(1);
    // still inside its validity: the settled row is confirmed later
    expect(await wallet.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [e.nonce], verified: [] });
  });

  it('reconcile(): a rejected authorization that was settled out of band becomes settled, with its transaction', async () => {
    const stub = await startStubPayee({
      payTo: payee.address,
      token: fx.usdc,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      network: NETWORK,
      price: '$0.001',
      facilitatorAddress: facilitator.address,
    });
    stubs.push(stub);
    stub.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    const { wallet, ledgerPath } = makeWallet();
    const m = await wallet.createIntentMandate({ naturalLanguage: 'x', limitAmount: '$1', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] }, { approve: true });
    expect((await wallet.fetch(`${stub.url}/predict`)).status).toBe(402);
    const [e] = new Ledger(ledgerPath).read();
    expect(e.status).toBe('rejected');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '1000' });

    // inside its window and unused: stays pending
    expect((await wallet.reconcile()).stillPending).toEqual([e.nonce]);

    // the payee (or anyone holding the signature) settles it after all
    const hash = await relay(e);
    const r = await wallet.reconcile();
    expect(r.settled).toEqual([e.nonce]);
    const after = new Ledger(ledgerPath).read()[0];
    expect(after).toMatchObject({ status: 'settled', verified: true, transaction: hash });
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '0' });
    // idempotent
    expect(await wallet.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [], verified: [] });
  });

  it('a wallet configured for another chain refuses to reconcile against this RPC', async () => {
    const { wallet, ledgerPath } = makeWallet({ network: 'eip155:84532' });
    new Ledger(ledgerPath).append({
      v: 2,
      kind: 'payment',
      timestamp: 1,
      url: 'http://x/y',
      host: 'x',
      resource: 'GET /y',
      network: 'eip155:84532',
      asset: fx.usdc,
      amount: '1',
      payer: payer.address,
      payee: payee.address,
      intentMandateId: 'im_x',
      nonce: `0x${'11'.repeat(32)}`,
      validBefore: 1,
      authorization: { from: payer.address, to: payee.address, value: '1', validAfter: '0', validBefore: '1', nonce: `0x${'11'.repeat(32)}` },
      signature: '0x',
      httpStatus: 402,
      status: 'rejected',
    });
    await expect(wallet.reconcile()).rejects.toThrow(/serves chain 31337 but this wallet is configured for eip155:84532/);
    expect(new Ledger(ledgerPath).read()[0].status).toBe('rejected'); // untouched
  });

  it('LAST: by chain time, expired authorizations release their budget and a payee that lied about settling is refunded', async () => {
    const stub = await startStubPayee({
      payTo: payee.address,
      token: fx.usdc,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      network: NETWORK,
      price: '$0.001',
      maxTimeoutSeconds: 30,
      facilitatorAddress: facilitator.address,
      rawMode: 'fake-success',
    });
    stubs.push(stub);
    const { wallet, ledgerPath } = makeWallet();
    const m = await wallet.createIntentMandate({ naturalLanguage: 'x', limitAmount: '$1', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] }, { approve: true });

    // (a) a refusal: reservation held
    stub.mode = { kind: 'invalid', reason: 'invalid_exact_evm_insufficient_balance' };
    expect((await wallet.fetch(`${stub.url}/predict`)).status).toBe(402);
    // (b) a payee claiming a settlement that never happened: counted as spent for now
    expect((await wallet.fetch(`${stub.url}/raw`)).status).toBe(200);
    const [rejected, lied] = new Ledger(ledgerPath).read();
    expect(rejected.status).toBe('rejected');
    expect(lied.status).toBe('settled');
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '1000', pendingSpentAmount: '1000' });

    // wall clock says expired, the chain does not yet: nothing moves
    const late = makeWallet({ ledgerPath, mandatesPath: join(ledgerPath, '..', 'mandates.json'), now: () => Math.floor(Date.now() / 1000) + 3600 });
    expect((await late.wallet.reconcile()).stillPending).toEqual([rejected.nonce, lied.nonce]);

    // chain time passes validBefore
    await testClient.increaseTime({ seconds: 31 });
    await testClient.mine({ blocks: 1 });
    expect(await chainNow()).toBeGreaterThanOrEqual(rejected.validBefore);
    const r = await wallet.reconcile();
    expect(r.expiredUnused.sort()).toEqual([rejected.nonce, lied.nonce].sort());
    const rows = new Ledger(ledgerPath).read();
    expect(rows.map((e) => e.status)).toEqual(['expired-unused', 'expired-unused']);
    expect(rows[1].error).toMatch(/never used on chain/);
    expect(wallet.getMandate(m.id)).toMatchObject({ spentAmount: '0', pendingSpentAmount: '0' });
    expect(wallet.remaining(m.id)).toBe(1_000_000n);
  });
});
