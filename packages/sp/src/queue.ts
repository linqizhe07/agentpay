import type { Hex } from '@agentpay/core';
import { isTerminalStatus, type JsonlStore, type QueueRecord } from './store.js';

export type Precheck =
  | { kind: 'free' }
  /** Digest already queued or settled: answer with its original receipt. */
  | { kind: 'existing'; rec: QueueRecord }
  /** Digest already failed/expired: it can never be re-enqueued. */
  | { kind: 'terminal'; rec: QueueRecord }
  /** (owner, nonce) is bound to a different mandate. */
  | { kind: 'nonce_conflict'; digest: Hex };

export type ClaimResult =
  | { ok: true; rec: QueueRecord; created: boolean }
  | { ok: false; code: 'mandate_terminal'; existing: QueueRecord }
  | { ok: false; code: 'nonce_used'; digest: Hex }
  | { ok: false; code: 'insufficient_balance'; debitable: bigint; reserved: bigint; amount: bigint };

/**
 * Admission control over the store. `claim` is atomic by virtue of Node's
 * single-threaded event loop: no await between its checks and the insert, so
 * two concurrent /enqueue calls can never both pass the funds check.
 */
export class Queue {
  constructor(readonly store: JsonlStore) {}

  precheck(digest: Hex, owner: string, nonce: string): Precheck {
    const rec = this.store.get(digest);
    if (rec) return isTerminalStatus(rec.status) ? { kind: 'terminal', rec } : { kind: 'existing', rec };
    const bound = this.store.digestForNonce(owner, nonce);
    if (bound && bound.toLowerCase() !== digest.toLowerCase()) return { kind: 'nonce_conflict', digest: bound };
    return { kind: 'free' };
  }

  /** Σ amounts of pending|settling records for (owner, token). */
  reserved(owner: string, token: string): bigint {
    return this.store.reserved(owner, token);
  }

  /** Re-runs the local checks against the current state and inserts the record. Synchronous. */
  claim(rec: QueueRecord, debitable: bigint): ClaimResult {
    const pre = this.precheck(rec.mandateDigest, rec.mandate.owner, rec.mandate.nonce);
    if (pre.kind === 'existing') return { ok: true, rec: pre.rec, created: false };
    if (pre.kind === 'terminal') return { ok: false, code: 'mandate_terminal', existing: pre.rec };
    if (pre.kind === 'nonce_conflict') return { ok: false, code: 'nonce_used', digest: pre.digest };
    const amount = BigInt(rec.mandate.amount);
    const reserved = this.reserved(rec.mandate.owner, rec.mandate.token);
    if (debitable < amount + reserved) {
      return { ok: false, code: 'insufficient_balance', debitable, reserved, amount };
    }
    this.store.insert(rec);
    return { ok: true, rec, created: true };
  }

  unsettled(owner: string, token: string): Hex[] {
    return this.store.unsettledFor(owner, token);
  }
}
