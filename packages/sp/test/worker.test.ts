import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEventLogs } from 'viem';
import { AEP2_DEBIT_WALLET_ABI } from '@agentpay/contracts';
import type { Hex, SpReceipt } from '@agentpay/core';
import type { SPHandle } from '../src/index.js';
import {
  AMOUNT,
  USDC,
  accounts,
  enqueue,
  extraAccount,
  fixture,
  fund,
  get,
  mkSP,
  nonceUsed,
  nowSec,
  publicClient,
  revoke,
  rpcProxy,
  settleDirect,
  signed,
  tmpStorePath,
  usdcBalance,
  waitFor,
  walletBalance,
} from './helpers.js';

describe('worker', () => {
  const spAddress = accounts.sp.address;
  const secondPayee = extraAccount(7);

  beforeAll(async () => {
    await fund(accounts.payer, USDC('50'), spAddress);
    await fund(accounts.stranger, USDC('50'), spAddress);
  });

  it('settles mandates from several owners in ONE settleBatch tx and pays every payee', async () => {
    const sp = mkSP();
    await sp.start();
    try {
      const a = await signed();
      const b = await signed({ payee: secondPayee.address, amount: '70000' });
      const c = await signed({ amount: '40000' }, accounts.stranger);
      for (const s of [a, b, c]) expect((await enqueue(sp, s)).status).toBe(200);

      const payeeBefore = await usdcBalance(accounts.payee.address);
      const secondBefore = await usdcBalance(secondPayee.address);
      const payerBefore = await walletBalance(accounts.payer.address);
      const strangerBefore = await walletBalance(accounts.stranger.address);

      const r = await sp.tick();
      expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect([...r.settled].sort()).toEqual([a.digest, b.digest, c.digest].sort());
      expect(r.skipped).toEqual([]);
      expect(r.expired).toEqual([]);
      expect(r.retried).toEqual([]);

      const receipt = await publicClient().getTransactionReceipt({ hash: r.txHash as Hex });
      const events = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'Settled' });
      expect(events.map((e) => e.args.mandateDigest).sort()).toEqual([a.digest, b.digest, c.digest].sort());
      for (const s of [a, b, c]) {
        expect(sp.store.get(s.digest)).toMatchObject({ status: 'settled', txHash: r.txHash, attempts: 0 });
        expect(await nonceUsed(s.mandate.owner, s.mandate.nonce)).toBe(true);
      }
      expect(await usdcBalance(accounts.payee.address)).toBe(payeeBefore + AMOUNT + 40_000n);
      expect(await usdcBalance(secondPayee.address)).toBe(secondBefore + 70_000n);
      expect(await walletBalance(accounts.payer.address)).toBe(payerBefore - AMOUNT - 70_000n);
      expect(await walletBalance(accounts.stranger.address)).toBe(strangerBefore - 40_000n);
      expect(sp.store.reserved(accounts.payer.address, fixture().usdc)).toBe(0n);
      expect(sp.store.reserved(accounts.stranger.address, fixture().usdc)).toBe(0n);

      const empty = await sp.tick();
      expect(empty).toEqual({ settled: [], skipped: [], expired: [], retried: [] });
      const health = await get(`${sp.url}/health`);
      expect(health.json.lastBatchAt).toBeGreaterThan(0);
    } finally {
      await sp.stop();
    }
  });

  it('recognizes a digest already settled on-chain outside the worker as settled, not failed', async () => {
    const sp = mkSP();
    await sp.start();
    try {
      const s = await signed();
      expect((await enqueue(sp, s)).status).toBe(200);
      const direct = await settleDirect(s); // e.g. another processor the payer authorized
      const r = await sp.tick();
      expect(r.settled).toEqual([s.digest]);
      expect(r.skipped).toEqual([]);
      expect(sp.store.get(s.digest)).toMatchObject({ status: 'settled', txHash: direct.transactionHash });
      expect(sp.store.reserved(accounts.payer.address, fixture().usdc)).toBe(0n);
    } finally {
      await sp.stop();
    }
  });

  it('drops a mandate whose nonce was consumed by a different mandate during simulation and settles the rest', async () => {
    const sp = mkSP();
    await sp.start();
    try {
      const items = [await signed(), await signed(), await signed({}, accounts.stranger)];
      for (const s of items) expect((await enqueue(sp, s)).status).toBe(200);
      await settleDirect(await signed({ nonce: items[1].mandate.nonce, amount: '1' })); // rival mandate, same nonce

      const r = await sp.tick();
      expect(r.skipped).toEqual([{ mandateDigest: items[1].digest, status: 'nonce_used' }]);
      expect([...r.settled].sort()).toEqual([items[0].digest, items[2].digest].sort());
      expect(sp.store.get(items[1].digest)).toMatchObject({ status: 'failed', errorCode: 'nonce_used' });
      expect(sp.store.get(items[1].digest)?.txHash).toBeUndefined(); // never sent
      expect(sp.store.get(items[0].digest)).toMatchObject({ status: 'settled', txHash: r.txHash });
      expect(sp.store.get(items[2].digest)).toMatchObject({ status: 'settled', txHash: r.txHash });

      const receipt = await publicClient().getTransactionReceipt({ hash: r.txHash as Hex });
      expect(parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'SettleSkipped' })).toEqual([]);
    } finally {
      await sp.stop();
    }
  });

  it('still settles a mandate enqueued before the payer revoked the SP (revocation is delayed by withdrawDelay)', async () => {
    const payer = extraAccount(8);
    await fund(payer, USDC('1'), spAddress);
    const sp = mkSP();
    await sp.start();
    try {
      const s = await signed({}, payer);
      const receipt = (await enqueue(sp, s)).json.receipt as SpReceipt;
      const revokeAt = await revoke(payer, spAddress); // the payer took delivery and revokes in the next block
      expect(revokeAt).toBeGreaterThanOrEqual(receipt.enqueueDeadline); // the receipt's promise is still keepable
      const r = await sp.tick();
      expect(r.settled).toEqual([s.digest]);
      expect(r.skipped).toEqual([]);
      expect(sp.store.get(s.digest)).toMatchObject({ status: 'settled', txHash: r.txHash });
      expect(await nonceUsed(s.mandate.owner, s.mandate.nonce)).toBe(true);
      expect(sp.store.reserved(payer.address, fixture().usdc)).toBe(0n);
    } finally {
      await sp.stop();
    }
  });

  it('expires a pending mandate inside the send margin without sending it', async () => {
    let t = nowSec();
    const sp = mkSP({ clock: () => t, sendMarginSeconds: 30 });
    await sp.start();
    try {
      const deadline = t + 300;
      const closeCall = await signed({ deadline });
      const fine = await signed();
      expect((await enqueue(sp, closeCall)).status).toBe(200);
      expect((await enqueue(sp, fine)).status).toBe(200);

      t = deadline - 10; // 10s left < 30s margin; the other one still has ~an hour
      const r = await sp.tick();
      expect(r.expired).toEqual([closeCall.digest]);
      expect(r.settled).toEqual([fine.digest]);
      expect(sp.store.get(closeCall.digest)).toMatchObject({ status: 'expired', attempts: 0 });
      expect(sp.store.get(closeCall.digest)?.txHash).toBeUndefined();
      expect(await nonceUsed(closeCall.mandate.owner, closeCall.mandate.nonce)).toBe(false);
      expect(sp.store.reserved(accounts.payer.address, fixture().usdc)).toBe(0n);

      const st = await get(`${sp.url}/status/${closeCall.digest}`);
      expect(st.json.status).toBe('expired');
      const again = await enqueue(sp, closeCall);
      expect(again.status).toBe(400); // its deadline is now too soon anyway
    } finally {
      await sp.stop();
    }
  });

  it('recovers after a restart on the same store file', async () => {
    const storePath = tmpStorePath('restart');
    const first = mkSP({ storePath });
    await first.start();
    const a = await signed();
    const b = await signed({}, accounts.stranger);
    const receiptA = (await enqueue(first, a)).json.receipt;
    expect((await enqueue(first, b)).status).toBe(200);
    await first.stop();
    expect(readFileSync(storePath, 'utf8').trim().split('\n')).toHaveLength(2);

    const second = mkSP({ storePath });
    await second.start();
    try {
      expect(second.store.size).toBe(2);
      expect(second.store.get(a.digest)?.status).toBe('pending');
      expect(second.store.reserved(accounts.payer.address, fixture().usdc)).toBe(AMOUNT);
      const st = await get(`${second.url}/status/${a.digest}`);
      expect(st.json.receipt).toEqual(receiptA);
      expect((await enqueue(second, a)).json.receipt).toEqual(receiptA); // idempotent across restarts

      const r = await second.tick();
      expect([...r.settled].sort()).toEqual([a.digest, b.digest].sort());
    } finally {
      await second.stop();
    }

    const third = mkSP({ storePath });
    await third.start();
    try {
      expect(third.store.get(a.digest)).toMatchObject({ status: 'settled' });
      expect(third.store.counts()).toEqual({ pending: 0, settling: 0, settled: 2, failed: 0, expired: 0 });
      expect(third.store.reserved(accounts.payer.address, fixture().usdc)).toBe(0n);
    } finally {
      await third.stop();
    }
  });

  it('reconciles records left settling by a crash', async () => {
    const storePath = tmpStorePath('reconcile');
    const crashed = mkSP({ storePath });
    await crashed.start();
    const landedWithHash = await signed();
    const landedNoHash = await signed();
    const neverSent = await signed();
    const skippedOnChain = await signed({}, accounts.stranger);
    const rivalled = await signed({}, accounts.stranger);
    for (const s of [landedWithHash, landedNoHash, neverSent, skippedOnChain, rivalled]) {
      expect((await enqueue(crashed, s)).status).toBe(200);
    }
    await crashed.stop();

    // Simulate the crash window: transactions went out, statuses never came back.
    const tx1 = (await settleDirect(landedWithHash)).transactionHash;
    await settleDirect(landedNoHash);
    // A batch tx that skipped the stranger's mandate because the same digest had
    // already been settled by another transaction (so it IS settled, just not by that batch).
    const consumed = await settleDirect(skippedOnChain);
    // A mandate whose nonce was consumed by a DIFFERENT mandate: never settled, no Settled event.
    await settleDirect(await signed({ nonce: rivalled.mandate.nonce, amount: '1' }, accounts.stranger));
    const { walletFor } = await import('./helpers.js');
    const { mandateToTuple } = await import('@agentpay/core');
    const skipHash = await walletFor(accounts.sp).writeContract({
      address: fixture().wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settleBatch',
      args: [[mandateToTuple(skippedOnChain.mandate)], [skippedOnChain.payerSig]],
    });
    await publicClient().waitForTransactionReceipt({ hash: skipHash });
    expect(consumed.status).toBe('success');

    const at = nowSec();
    crashed.store.update(landedWithHash.digest, { status: 'settling', txHash: tx1 }, at);
    crashed.store.update(landedNoHash.digest, { status: 'settling' }, at);
    crashed.store.update(neverSent.digest, { status: 'settling' }, at);
    crashed.store.update(skippedOnChain.digest, { status: 'settling', txHash: skipHash }, at);
    crashed.store.update(rivalled.digest, { status: 'settling' }, at);

    const recovered = mkSP({ storePath });
    await recovered.start();
    try {
      expect(recovered.store.get(landedWithHash.digest)).toMatchObject({ status: 'settled', txHash: tx1 });
      expect(recovered.store.get(landedNoHash.digest)).toMatchObject({ status: 'settled' });
      expect(recovered.store.get(neverSent.digest)).toMatchObject({ status: 'pending' });
      // The skip proves nothing by itself; the Settled event for this digest (from `consumed`) does.
      expect(recovered.store.get(skippedOnChain.digest)).toMatchObject({ status: 'settled', txHash: consumed.transactionHash });
      // A consumed nonce without a Settled event for THIS digest is a failure, not a settlement.
      expect(recovered.store.get(rivalled.digest)).toMatchObject({ status: 'failed', errorCode: 'nonce_used' });
      expect(recovered.store.reserved(accounts.payer.address, fixture().usdc)).toBe(AMOUNT);
      expect(recovered.store.reserved(accounts.stranger.address, fixture().usdc)).toBe(0n);

      const r = await recovered.tick();
      expect(r.settled).toEqual([neverSent.digest]);
    } finally {
      await recovered.stop();
    }
  });

  it('backs off on RPC outages without burning attempts, and settles once the RPC is back', async () => {
    const proxy = await rpcProxy(fixture().rpcUrl);
    let t = nowSec();
    const sp = mkSP({ rpcUrl: proxy.url, clock: () => t, maxAttempts: 3 });
    await sp.start();
    try {
      const s = await signed();
      expect((await enqueue(sp, s)).status).toBe(200);

      proxy.dead = true;
      const r1 = await sp.tick();
      expect(r1).toEqual({ settled: [], skipped: [], expired: [], retried: [s.digest] });
      // A dead RPC is not the mandate's fault: attempts stay 0, only a fixed backoff is set.
      expect(sp.store.get(s.digest)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: t + 30 });
      expect(await nonceUsed(s.mandate.owner, s.mandate.nonce)).toBe(false);

      const r2 = await sp.tick(); // still backing off: not even attempted
      expect(r2.retried).toEqual([]);

      // However long the outage, a receipted mandate never turns terminal (maxAttempts
      // is for deterministic failures); only its deadline can expire it.
      for (let i = 0; i < 5; i++) {
        t += 31;
        const r = await sp.tick();
        expect(r.retried).toEqual([s.digest]);
      }
      expect(sp.store.get(s.digest)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(sp.store.reserved(accounts.payer.address, fixture().usdc)).toBeGreaterThanOrEqual(AMOUNT);

      proxy.dead = false;
      t += 31;
      const r4 = await sp.tick();
      expect(r4.settled).toEqual([s.digest]);
      expect(sp.store.get(s.digest)).toMatchObject({ status: 'settled', attempts: 0, txHash: r4.txHash });
    } finally {
      await sp.stop();
      await proxy.close();
    }
  });

  it('kicks a batch as soon as pending reaches batchMax', async () => {
    const sp = mkSP({ batchMax: 2 });
    await sp.start();
    try {
      const a = await signed();
      const b = await signed();
      expect((await enqueue(sp, a)).status).toBe(200);
      expect(sp.store.get(a.digest)?.status).toBe('pending');
      expect((await enqueue(sp, b)).status).toBe(200);
      await waitFor(() => sp.store.get(b.digest)?.status === 'settled');
      expect(sp.store.get(a.digest)?.status).toBe('settled');
      expect(sp.store.get(a.digest)?.txHash).toBe(sp.store.get(b.digest)?.txHash);
    } finally {
      await sp.stop();
    }
  });

  it('ticks on the configured interval and tick() joins an in-flight batch', async () => {
    const sp = mkSP({ batchIntervalMs: 100 });
    await sp.start();
    try {
      const s = await signed();
      expect((await enqueue(sp, s)).status).toBe(200);
      await waitFor(() => sp.store.get(s.digest)?.status === 'settled');

      const t = await signed();
      expect((await enqueue(sp, t)).status).toBe(200);
      const [x, y] = await Promise.all([sp.tick(), sp.tick()]);
      expect(x).toBe(y);
      expect(x.settled).toEqual([t.digest]);
    } finally {
      await sp.stop();
    }
  });
});
