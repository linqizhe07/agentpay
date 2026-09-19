import type { TransactionReceipt } from 'viem';
import { short, type Hex } from '@agentpay/core';
import { REVERT_STATUS, classifyError, errorMessage, parseSettleLogs, statusName, type ChainClient } from './chain.js';
import type { ResolvedSPConfig } from './config.js';
import type { JsonlStore, QueueRecord, RecordPatch } from './store.js';

export interface TickResult {
  /** The settleBatch transaction (or the first single settle) sent by this tick. */
  txHash?: Hex;
  settled: Hex[];
  /** Dropped before sending (simulation) or skipped on-chain (SettleSkipped), with the reason. */
  skipped: { mandateDigest: Hex; status: string }[];
  /** Expired locally: too close to their deadline to be sent. */
  expired: Hex[];
  /** Send/receipt failures: attempts bumped, back to pending after a backoff. */
  retried: Hex[];
}

export interface ReconcileResult {
  settled: Hex[];
  requeued: Hex[];
  skipped: { mandateDigest: Hex; status: string }[];
}

export interface WorkerDeps {
  store: JsonlStore;
  chain: ChainClient;
  cfg: Pick<
    ResolvedSPConfig,
    'batchIntervalMs' | 'batchMax' | 'sendMarginSeconds' | 'maxAttempts'
  >;
  log: (line: string) => void;
  clock: () => number;
}

const NONCE_USED = 3;
const EXPIRED = 2;
/** Fixed backoff after a transport failure (RPC down, timeout): the mandate is not at fault. */
const TRANSPORT_BACKOFF_SECONDS = 30;

type FailureKind =
  /** RPC/network trouble: retry later, never terminal (the deadline check is the only clock). */
  | 'transport'
  /** The chain rejected or ignored the settlement: counts toward maxAttempts. */
  | 'deterministic';

/**
 * Batches pending mandates into settleBatch transactions. One batch in flight at
 * a time; `tick()` during a run returns the in-flight promise.
 */
export class Worker {
  /** Unix seconds of the last mined settlement transaction. */
  lastBatchAt: number | undefined;
  /**
   * Block of the last settlement receipt this process applied. Admission reads
   * at an older block would see balances the settlement already consumed, so
   * the server refuses chain views behind it.
   */
  lastSettledBlock: number | undefined;
  private inflight: Promise<TickResult> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: WorkerDeps) {}

  /** Starts the periodic tick (no-op when batchIntervalMs is 0). */
  start(): void {
    if (this.timer || this.d.cfg.batchIntervalMs <= 0) return;
    this.timer = setInterval(() => this.kick(), this.d.cfg.batchIntervalMs);
    this.timer.unref();
  }

  /** Stops the periodic tick and waits for an in-flight batch. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight.catch(() => undefined);
  }

  /** Fire-and-forget tick (interval / batchMax trigger); errors only get logged. */
  kick(): void {
    this.tick().catch((err) => this.d.log(`sp: tick failed: ${errorMessage(err)}`));
  }

  tick(): Promise<TickResult> {
    if (this.inflight) return this.inflight;
    const run = this.runTick().finally(() => {
      if (this.inflight === run) this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  private async runTick(): Promise<TickResult> {
    const { store, chain, cfg, log, clock } = this.d;
    const result: TickResult = { settled: [], skipped: [], expired: [], retried: [] };
    const now = clock();

    // (a) too close to the deadline to make it on-chain: expire locally, never send.
    const candidates: QueueRecord[] = [];
    for (const rec of store.byStatus('pending')) {
      if (rec.mandate.deadline < now + cfg.sendMarginSeconds) {
        store.update(rec.mandateDigest, { status: 'expired' }, now);
        result.expired.push(rec.mandateDigest);
        log(`sp: ${short(rec.mandateDigest)} expired (deadline ${rec.mandate.deadline} within ${cfg.sendMarginSeconds}s)`);
        continue;
      }
      if ((rec.nextAttemptAt ?? 0) > now) continue; // backing off
      candidates.push(rec);
    }
    candidates.sort((a, b) => a.mandate.deadline - b.mandate.deadline || a.enqueuedAt - b.enqueuedAt);
    const batch = candidates.slice(0, cfg.batchMax);
    if (batch.length === 0) return result;

    // (b) dry run: drop items the contract would skip anyway, before spending gas.
    let statuses: number[];
    try {
      statuses = await chain.simulateSettleBatch(batch);
    } catch (err) {
      const kind = classifyError(err);
      if (kind.kind === 'revert') {
        log(`sp: settleBatch simulation reverted (${kind.message}); settling ${batch.length} item(s) one by one`);
        await this.settleIndividually(batch, result);
        return result;
      }
      this.recordSendFailure(batch, `simulation: ${kind.message}`, result, 'transport');
      return result;
    }
    const survivors: QueueRecord[] = [];
    for (let i = 0; i < batch.length; i++) {
      const status = statuses[i] ?? 6;
      if (status === 0) survivors.push(batch[i]);
      else await this.markSkipped(batch[i], status, undefined, result);
    }
    if (survivors.length === 0) return result;

    // (c) send, persist the hash, wait, apply the events.
    await this.markSettling(survivors);
    let hash: Hex;
    try {
      hash = await chain.sendSettleBatch(survivors);
    } catch (err) {
      const kind = classifyError(err);
      if (kind.kind === 'revert') {
        log(`sp: settleBatch send reverted (${kind.message}); settling ${survivors.length} item(s) one by one`);
        await this.settleIndividually(survivors, result);
        return result;
      }
      this.recordSendFailure(survivors, `send: ${kind.message}`, result, 'transport');
      return result;
    }
    result.txHash = hash;
    const sentAt = clock();
    for (const rec of survivors) store.update(rec.mandateDigest, { txHash: hash }, sentAt);
    log(`sp: sent settleBatch(${survivors.length}) ${hash}`);

    let receipt: TransactionReceipt;
    try {
      receipt = await chain.waitForReceipt(hash);
    } catch (err) {
      this.recordSendFailure(survivors, `waiting for ${hash}: ${errorMessage(err)}`, result, 'transport');
      return result;
    }
    this.lastBatchAt = clock();
    if (receipt.status === 'reverted') {
      log(`sp: settleBatch ${hash} reverted on-chain; settling ${survivors.length} item(s) one by one`);
      await this.settleIndividually(survivors, result);
      return result;
    }
    await this.applyReceipt(survivors, receipt, result);
    return result;
  }

  /** Fallback when a whole batch reverts (a token transfer failed): isolate the culprit. */
  private async settleIndividually(items: QueueRecord[], result: TickResult): Promise<void> {
    const { store, chain, clock, log } = this.d;
    for (const rec of items) {
      await this.markSettling([rec]);
      let hash: Hex;
      try {
        hash = await chain.sendSettle(rec);
      } catch (err) {
        const kind = classifyError(err);
        const status = kind.kind === 'revert' && kind.errorName ? REVERT_STATUS[kind.errorName] : undefined;
        if (status !== undefined) await this.markSkipped(rec, status, undefined, result);
        else this.recordSendFailure([rec], `settle: ${kind.message}`, result, kind.kind === 'revert' ? 'deterministic' : 'transport');
        continue;
      }
      result.txHash ??= hash;
      store.update(rec.mandateDigest, { txHash: hash }, clock());
      log(`sp: sent settle ${short(rec.mandateDigest)} ${hash}`);
      let receipt: TransactionReceipt;
      try {
        receipt = await chain.waitForReceipt(hash);
      } catch (err) {
        this.recordSendFailure([rec], `waiting for ${hash}: ${errorMessage(err)}`, result, 'transport');
        continue;
      }
      this.lastBatchAt = clock();
      if (receipt.status === 'reverted') {
        this.recordSendFailure([rec], `settle ${hash} reverted on-chain`, result, 'deterministic');
        continue;
      }
      await this.applyReceipt([rec], receipt, result);
    }
  }

  private async markSettling(items: QueueRecord[]): Promise<void> {
    const { store, chain, clock } = this.d;
    let block: number | undefined;
    try {
      block = await chain.blockNumber();
    } catch {
      block = undefined;
    }
    const at = clock();
    for (const rec of items) {
      const patch: RecordPatch = { status: 'settling' };
      // Keep the FIRST send's block so a later log scan covers every attempt.
      if (rec.sentBlock === undefined && block !== undefined) patch.sentBlock = block;
      store.update(rec.mandateDigest, patch, at);
    }
  }

  private async applyReceipt(items: QueueRecord[], receipt: TransactionReceipt, result: TickResult): Promise<void> {
    const { store, clock, log } = this.d;
    const { settled, skipped } = parseSettleLogs(receipt);
    this.lastSettledBlock = Math.max(this.lastSettledBlock ?? 0, Number(receipt.blockNumber));
    for (const rec of items) {
      const key = rec.mandateDigest.toLowerCase();
      if (settled.has(key)) {
        store.update(rec.mandateDigest, { status: 'settled', txHash: receipt.transactionHash }, clock());
        result.settled.push(rec.mandateDigest);
        log(`sp: ${short(rec.mandateDigest)} settled in ${receipt.transactionHash}`);
      } else if (skipped.has(key)) {
        await this.markSkipped(rec, skipped.get(key) ?? 6, receipt.transactionHash, result);
      } else {
        // The transaction neither settled nor skipped it: treat as a failed send and retry.
        this.recordSendFailure([rec], `no Settled/SettleSkipped event for it in ${receipt.transactionHash}`, result, 'deterministic');
      }
    }
  }

  /**
   * Terminal state for a contract-reported status. NonceUsed gets one extra
   * look: if THIS digest was settled on-chain (by an earlier attempt of ours,
   * or by another processor the payer authorized), the payee was paid — it is
   * settled, not failed.
   */
  private async markSkipped(rec: QueueRecord, status: number, txHash: Hex | undefined, result: TickResult): Promise<void> {
    const { store, clock, log } = this.d;
    if (status === NONCE_USED) {
      const settledTx = await this.findSettlement(rec);
      if (settledTx) {
        store.update(rec.mandateDigest, { status: 'settled', txHash: settledTx }, clock());
        result.settled.push(rec.mandateDigest);
        log(`sp: ${short(rec.mandateDigest)} was already settled in ${settledTx}`);
        return;
      }
    }
    const name = statusName(status);
    const patch: RecordPatch = status === EXPIRED ? { status: 'expired' } : { status: 'failed', errorCode: name };
    if (txHash) patch.txHash = txHash;
    store.update(rec.mandateDigest, patch, clock());
    result.skipped.push({ mandateDigest: rec.mandateDigest, status: name });
    log(`sp: ${short(rec.mandateDigest)} skipped: ${name}`);
  }

  /**
   * The transaction that emitted Settled for THIS digest, if any: first the hash
   * we recorded, then a log scan from the block we first sent it at (or from
   * genesis when it was never sent — a consumed nonce alone proves nothing,
   * since the payer may have signed another mandate with the same nonce).
   */
  private async findSettlement(rec: QueueRecord): Promise<Hex | undefined> {
    const { chain } = this.d;
    if (rec.txHash) {
      const receipt = await chain.getReceipt(rec.txHash).catch(() => undefined);
      if (receipt?.status === 'success' && parseSettleLogs(receipt).settled.has(rec.mandateDigest.toLowerCase())) {
        return rec.txHash;
      }
    }
    return chain.findSettledTx(rec.mandate.owner, rec.mandateDigest, rec.sentBlock ?? 0);
  }

  private recordSendFailure(items: QueueRecord[], message: string, result: TickResult, kind: FailureKind): void {
    const { store, cfg, clock, log } = this.d;
    const at = clock();
    if (kind === 'transport') {
      // Not the mandate's fault: keep `attempts` untouched so an RPC outage can
      // never turn a receipted mandate terminal; only its deadline can.
      for (const rec of items) {
        store.update(rec.mandateDigest, { status: 'pending', nextAttemptAt: at + TRANSPORT_BACKOFF_SECONDS }, at);
        result.retried.push(rec.mandateDigest);
      }
      log(`sp: transport failure for ${items.length} item(s), retry in ${TRANSPORT_BACKOFF_SECONDS}s: ${message}`);
      return;
    }
    for (const rec of items) {
      const attempts = rec.attempts + 1;
      if (attempts >= cfg.maxAttempts) {
        store.update(rec.mandateDigest, { status: 'failed', errorCode: 'send_failed', attempts }, at);
        result.skipped.push({ mandateDigest: rec.mandateDigest, status: 'send_failed' });
        log(`sp: ${short(rec.mandateDigest)} failed after ${attempts} attempts: ${message}`);
      } else {
        const backoff = Math.min(2 ** attempts, 60);
        store.update(rec.mandateDigest, { status: 'pending', attempts, nextAttemptAt: at + backoff }, at);
        result.retried.push(rec.mandateDigest);
      }
    }
    log(`sp: send failed for ${items.length} item(s), will retry: ${message}`);
  }

  /**
   * Startup recovery for records left `settling` by a crash: a known txHash is
   * checked for its receipt; otherwise (or if the tx never mined) the on-chain
   * nonce decides — used means it landed, unused means it goes back to pending.
   * RPC failures propagate (the caller refuses to start on a chain it cannot read).
   */
  async reconcile(): Promise<ReconcileResult> {
    const { store, chain, clock, log } = this.d;
    const result: ReconcileResult = { settled: [], requeued: [], skipped: [] };
    const tickView: TickResult = { settled: [], skipped: [], expired: [], retried: [] };
    for (const rec of store.byStatus('settling')) {
      const key = rec.mandateDigest.toLowerCase();
      let decided = false;
      if (rec.txHash) {
        const receipt = await chain.getReceipt(rec.txHash);
        if (receipt?.status === 'success') {
          const { settled, skipped } = parseSettleLogs(receipt);
          if (settled.has(key)) {
            store.update(rec.mandateDigest, { status: 'settled' }, clock());
            result.settled.push(rec.mandateDigest);
            decided = true;
          } else if (skipped.has(key)) {
            await this.markSkipped(rec, skipped.get(key) ?? 6, rec.txHash, tickView);
            decided = true;
          }
        }
      }
      if (!decided) {
        const used = await chain.nonceUsed(rec.mandate.owner, rec.mandate.nonce);
        if (used) {
          // A consumed nonce only proves settlement if a Settled event names THIS digest.
          const settledTx = await this.findSettlement(rec);
          if (settledTx) {
            store.update(rec.mandateDigest, { status: 'settled', txHash: settledTx }, clock());
            result.settled.push(rec.mandateDigest);
          } else {
            store.update(rec.mandateDigest, { status: 'failed', errorCode: 'nonce_used' }, clock());
            result.skipped.push({ mandateDigest: rec.mandateDigest, status: 'nonce_used' });
          }
        } else {
          store.update(rec.mandateDigest, { status: 'pending', nextAttemptAt: 0 }, clock());
          result.requeued.push(rec.mandateDigest);
        }
      }
    }
    result.settled.push(...tickView.settled);
    result.skipped.push(...tickView.skipped);
    if (result.settled.length || result.requeued.length || result.skipped.length) {
      log(
        `sp: recovered ${result.settled.length} settled, ${result.requeued.length} requeued, ${result.skipped.length} skipped`,
      );
    }
    return result;
  }
}
