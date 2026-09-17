// Chain-backed suite: hardhat on :8549 (see global-setup.ts). Skipped with
// AGENTPAY_SKIP_CHAIN_TESTS=1.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { AEP2_DEBIT_WALLET_ABI, MOCK_USDC_ABI } from '@agentpay/contracts';
import { mandateToTuple } from '@agentpay/core';
import { MandateWallet, type LedgerEntry } from '../src/index.js';
import type { ChainFixture } from './global-setup.js';
import { KEYS, startStubPayee, type StubPayee } from './stub-payee.js';

const SKIP = process.env.AGENTPAY_SKIP_CHAIN_TESTS === '1';
const NETWORK = 'eip155:31337';
const PRICE = '1000';

describe.skipIf(SKIP)('MandateWallet on hardhat', () => {
  let fx: ChainFixture;
  let wallet: MandateWallet;
  let dir: string;
  const payer = privateKeyToAccount(KEYS.payer);
  const sp = privateKeyToAccount(KEYS.sp);
  let publicClient: ReturnType<typeof createPublicClient>;
  let testClient: ReturnType<typeof createTestClient>;
  let spClient: ReturnType<typeof createWalletClient>;
  const servers: StubPayee[] = [];

  const usdcBalance = (who: Address) =>
    publicClient.readContract({ address: fx.usdc, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [who] });
  const chainNow = async () => Number((await publicClient.getBlock()).timestamp);

  beforeAll(() => {
    fx = inject('agentpayChain');
    const transport = http(fx.rpcUrl, { retryCount: 0 });
    publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
    testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport, pollingInterval: 50 });
    spClient = createWalletClient({ chain: hardhat, transport, account: sp, pollingInterval: 50 });
    dir = mkdtempSync(join(tmpdir(), 'agentpay-wallet-chain-'));
    wallet = new MandateWallet({
      key: KEYS.payer,
      rpcUrl: fx.rpcUrl,
      walletContract: fx.wallet,
      token: fx.usdc,
      network: NETWORK,
      mandatesPath: join(dir, 'mandates.json'),
      ledgerPath: join(dir, 'ledger.jsonl'),
    });
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it('deposit: approve + deposit are mined; balance and debitable reflect it', async () => {
    const before = await usdcBalance(payer.address);
    const { approveTx, depositTx } = await wallet.deposit(5_000_000n);
    expect(approveTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(depositTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await publicClient.getTransactionReceipt({ hash: depositTx })).status).toBe('success');
    expect(await wallet.balance()).toBe(5_000_000n);
    expect(await wallet.debitable()).toBe(5_000_000n);
    expect(await usdcBalance(payer.address)).toBe(before - 5_000_000n);
    expect(await usdcBalance(fx.wallet)).toBe(5_000_000n);
  });

  it('authorizeSP / isSpAuthorized round trip', async () => {
    expect(await wallet.isSpAuthorized(sp.address)).toBe(false);
    await wallet.authorizeSP(sp.address);
    expect(await wallet.isSpAuthorized(sp.address)).toBe(true);
    await wallet.authorizeSP(sp.address, false);
    expect(await wallet.isSpAuthorized(sp.address)).toBe(false);
    await wallet.authorizeSP(sp.address, true);
    expect(await wallet.isSpAuthorized(sp.address)).toBe(true);
  });

  it('a wallet configured for another network refuses to transact against this RPC', async () => {
    const wrong = new MandateWallet({
      key: KEYS.payer,
      rpcUrl: fx.rpcUrl,
      walletContract: fx.wallet,
      token: fx.usdc,
      network: 'eip155:84532',
      ledgerPath: join(dir, 'unused.jsonl'),
    });
    await expect(wrong.authorizeSP(sp.address)).rejects.toThrow(/chain/i);
  });

  it('requestWithdraw / pendingWithdrawal / cancelWithdraw / executeWithdraw round trip', async () => {
    expect(await wallet.pendingWithdrawal()).toEqual({ amount: 0n, unlockAt: 0 });
    await wallet.requestWithdraw(1_000_000n);
    const pending = await wallet.pendingWithdrawal();
    expect(pending.amount).toBe(1_000_000n);
    expect(pending.unlockAt).toBe((await chainNow()) + fx.withdrawDelay);
    expect(await wallet.balance()).toBe(5_000_000n);
    expect(await wallet.debitable()).toBe(4_000_000n);
    await expect(wallet.executeWithdraw()).rejects.toThrow(/WithdrawalLocked/);

    await wallet.cancelWithdraw();
    expect(await wallet.pendingWithdrawal()).toEqual({ amount: 0n, unlockAt: 0 });
    expect(await wallet.debitable()).toBe(5_000_000n);

    await wallet.requestWithdraw(1_000_000n);
    await testClient.increaseTime({ seconds: fx.withdrawDelay + 1 });
    await testClient.mine({ blocks: 1 });
    const before = await usdcBalance(payer.address);
    const tx = await wallet.executeWithdraw();
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await usdcBalance(payer.address)).toBe(before + 1_000_000n);
    expect(await wallet.balance()).toBe(4_000_000n);
    expect(await wallet.pendingWithdrawal()).toEqual({ amount: 0n, unlockAt: 0 });
    // executeWithdraw(to) pays a third party
    await wallet.requestWithdraw(500_000n);
    await testClient.increaseTime({ seconds: fx.withdrawDelay + 1 });
    await testClient.mine({ blocks: 1 });
    const stranger = privateKeyToAccount(KEYS.stranger).address;
    const strangerBefore = await usdcBalance(stranger);
    await wallet.executeWithdraw(stranger);
    expect(await usdcBalance(stranger)).toBe(strangerBefore + 500_000n);
    expect(await wallet.balance()).toBe(3_500_000n);
  });

  it('reconcile(): settled out-of-band (with tx) vs expired unused (budget released) vs still pending', async () => {
    let t = Math.floor(Date.now() / 1000);
    const w = new MandateWallet({
      key: KEYS.payer,
      rpcUrl: fx.rpcUrl,
      walletContract: fx.wallet,
      token: fx.usdc,
      network: NETWORK,
      mandatesPath: join(dir, 'mandates-reconcile.json'),
      ledgerPath: join(dir, 'ledger-reconcile.jsonl'),
      now: () => t,
    });
    const im = await w.createIntentMandate(
      { naturalLanguage: 'reconcile test', limitAmount: '$1', validForSeconds: 86_400, hostAllowlist: ['127.0.0.1'] },
      { approve: true },
    );
    const base = { payeeKey: KEYS.payee, spKey: KEYS.sp, wallet: fx.wallet, token: fx.usdc, network: NETWORK, price: PRICE };
    // long window: deadline t + 3660 (the chain clock is already ~20 min ahead of the wallet clock from the withdraw test)
    const longA = await startStubPayee({ ...base, settleWindowSeconds: 3600 });
    const longC = await startStubPayee({ ...base, settleWindowSeconds: 3600 });
    // short window: deadline t + 120
    const shortB = await startStubPayee({ ...base, settleWindowSeconds: 60 });
    const shortD = await startStubPayee({
      ...base,
      settleWindowSeconds: 60,
      mode: { reject: { status: 402, body: { error: 'settlement_unavailable: rpc_error' } } },
    });
    servers.push(longA, longC, shortB, shortD);

    expect((await w.fetch(`${longA.url}/predict`)).status).toBe(200); // A: will be settled out-of-band
    expect((await w.fetch(`${shortB.url}/predict`)).status).toBe(200); // B: enqueued, SP never settles -> SP default
    expect((await w.fetch(`${longC.url}/predict`)).status).toBe(200); // C: enqueued, still inside its window
    expect((await w.fetch(`${shortD.url}/predict`)).status).toBe(402); // D: rejected, reservation held
    const entries = readFileSync(join(dir, 'ledger-reconcile.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LedgerEntry);
    expect(entries.map((e) => e.status)).toEqual(['enqueued', 'enqueued', 'enqueued', 'rejected']);
    expect(w.getMandate(im.id)).toMatchObject({ spentAmount: '3000', pendingSpentAmount: '1000' });
    const [A, B, C, D] = entries;

    // Nothing settled yet: everything is pending.
    const first = await w.reconcile();
    expect(first).toEqual({ settled: [], expiredUnused: [], stillPending: [A, B, C, D].map((e) => e.mandateDigest) });

    // The SP settles A on-chain, out of band.
    const balanceBefore = await w.balance();
    const hash = await spClient.writeContract({
      address: fx.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settle',
      args: [mandateToTuple(A.mandate), A.payerSig],
      chain: hardhat,
      account: sp,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(await w.balance()).toBe(balanceBefore - 1000n);

    // Wallet clock passes B's and D's deadline + grace (t + 120 + 60), not A's/C's.
    t += 181;
    const second = await w.reconcile();
    expect(second.settled).toEqual([A.mandateDigest]);
    expect(second.expiredUnused).toEqual([B.mandateDigest, D.mandateDigest]);
    expect(second.stillPending).toEqual([C.mandateDigest]);

    const after = Object.fromEntries(
      readFileSync(join(dir, 'ledger-reconcile.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as LedgerEntry)
        .map((e) => [e.mandateDigest, e]),
    );
    expect(after[A.mandateDigest].status).toBe('settled');
    expect(after[A.mandateDigest].settledTx).toBe(hash);
    expect(after[B.mandateDigest].status).toBe('expired-unused');
    expect(after[B.mandateDigest].error).toMatch(/^sp_default/);
    expect(after[C.mandateDigest].status).toBe('enqueued');
    expect(after[D.mandateDigest].status).toBe('expired-unused');
    expect(after[D.mandateDigest].error).toBe('settlement_unavailable: rpc_error'); // untouched

    // Budget: A stays spent, B's spend is given back (SP default), D's reservation is released, C stays spent.
    expect(w.getMandate(im.id)).toMatchObject({ spentAmount: '2000', pendingSpentAmount: '0' });
    expect(w.remaining(im.id)).toBe(998_000n);
    const report = w.report();
    expect(report.totals).toEqual({
      spent: '2000',
      pending: '0',
      enqueued: 1,
      settled: 1,
      rejected: 0,
      unknown: 0,
      expiredUnused: 2,
      spDefaults: 1,
    });

    // Idempotent: a third pass only re-lists C.
    expect(await w.reconcile()).toEqual({ settled: [], expiredUnused: [], stillPending: [C.mandateDigest] });
    expect(w.getMandate(im.id)).toMatchObject({ spentAmount: '2000', pendingSpentAmount: '0' });

    // A rejected entry whose mandate the SP nevertheless settled converts its reservation to spend.
    const late = await startStubPayee({
      ...base,
      settleWindowSeconds: 3600,
      mode: { reject: { status: 402, body: { error: 'settlement_unavailable: timeout' } } },
    });
    servers.push(late);
    expect((await w.fetch(`${late.url}/predict`)).status).toBe(402);
    const E = late.mandates[0];
    const hashE = await spClient.writeContract({
      address: fx.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settle',
      args: [mandateToTuple(E.mandate), E.payerSig],
      chain: hardhat,
      account: sp,
    });
    await publicClient.waitForTransactionReceipt({ hash: hashE });
    const third = await w.reconcile();
    expect(third.settled).toHaveLength(1);
    expect(w.getMandate(im.id)).toMatchObject({ spentAmount: '3000', pendingSpentAmount: '0' });
    const settledHashes = third.settled as Hex[];
    expect(settledHashes).toHaveLength(1);
  });
});
