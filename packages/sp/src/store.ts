import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Hex, Mandate, SpReceipt } from '@agentpay/core';

export type RecordStatus = 'pending' | 'settling' | 'settled' | 'failed' | 'expired';

export const RECORD_STATUSES: readonly RecordStatus[] = ['pending', 'settling', 'settled', 'failed', 'expired'];

/** pending and settling mandates hold a reservation against the payer's debitable balance. */
export function isReservedStatus(status: RecordStatus): boolean {
  return status === 'pending' || status === 'settling';
}

export function isTerminalStatus(status: RecordStatus): boolean {
  return !isReservedStatus(status);
}

/** One enqueued mandate and everything the SP knows about its settlement. */
export interface QueueRecord {
  mandateDigest: Hex;
  chainId: number;
  wallet: Address;
  mandate: Mandate;
  payerSig: Hex;
  receipt: SpReceipt;
  status: RecordStatus;
  /** Set with status 'failed': sp_not_authorized | nonce_used | insufficient_balance | invalid_signature | bad_params | send_failed. */
  errorCode?: string;
  txHash?: Hex;
  /** Send failures so far. */
  attempts: number;
  /** Unix seconds before which the worker leaves a backed-off record alone. */
  nextAttemptAt?: number;
  /** Block number observed right before the record was FIRST sent (bounds log scans on recovery). */
  sentBlock?: number;
  enqueuedAt: number;
  updatedAt: number;
}

export type RecordPatch = Partial<
  Pick<QueueRecord, 'status' | 'errorCode' | 'txHash' | 'attempts' | 'nextAttemptAt' | 'sentBlock'>
>;

export type StoreEvent =
  | { t: 'enq'; rec: QueueRecord }
  | { t: 'upd'; digest: Hex; patch: RecordPatch; at: number };

const nonceKey = (owner: string, nonce: string): string => `${owner.toLowerCase()}|${BigInt(nonce).toString()}`;
const tokenKey = (owner: string, token: string): string => `${owner.toLowerCase()}|${token.toLowerCase()}`;

function parseEvent(line: string, lineNo: number, path: string): StoreEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`corrupt store line ${lineNo} in ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`corrupt store line ${lineNo} in ${path}: not an object`);
  const ev = parsed as Record<string, unknown>;
  if (ev.t === 'enq') {
    const rec = ev.rec as Record<string, unknown> | undefined;
    if (
      typeof rec !== 'object' ||
      rec === null ||
      typeof rec.mandateDigest !== 'string' ||
      typeof rec.mandate !== 'object' ||
      rec.mandate === null ||
      typeof rec.status !== 'string'
    ) {
      throw new Error(`corrupt store line ${lineNo} in ${path}: malformed enq event`);
    }
    return parsed as StoreEvent;
  }
  if (ev.t === 'upd') {
    if (typeof ev.digest !== 'string' || typeof ev.patch !== 'object' || ev.patch === null || typeof ev.at !== 'number') {
      throw new Error(`corrupt store line ${lineNo} in ${path}: malformed upd event`);
    }
    return parsed as StoreEvent;
  }
  throw new Error(`corrupt store line ${lineNo} in ${path}: unknown event type ${JSON.stringify(ev.t)}`);
}

/**
 * Append-only JSONL event log folded into an in-memory map on open.
 * Events: {t:'enq', rec} inserts a record; {t:'upd', digest, patch, at} patches it.
 * Without a path the store is memory-only. Only a truncated LAST line (a write cut
 * short by a crash) is tolerated: it is dropped and the file repaired; any other
 * malformed line throws.
 */
export class JsonlStore {
  readonly path: string | undefined;
  private readonly records = new Map<string, QueueRecord>();
  private readonly byOwnerNonce = new Map<string, Hex>();
  private readonly reservedByOwnerToken = new Map<string, bigint>();

  constructor(path?: string, private readonly log: (line: string) => void = () => {}) {
    this.path = path;
    if (path) this.open(path);
  }

  get size(): number {
    return this.records.size;
  }

  get(digest: string): QueueRecord | undefined {
    return this.records.get(digest.toLowerCase());
  }

  has(digest: string): boolean {
    return this.records.has(digest.toLowerCase());
  }

  all(): QueueRecord[] {
    return [...this.records.values()];
  }

  byStatus(status: RecordStatus): QueueRecord[] {
    return this.all().filter((r) => r.status === status);
  }

  counts(): Record<RecordStatus, number> {
    const counts: Record<RecordStatus, number> = { pending: 0, settling: 0, settled: 0, failed: 0, expired: 0 };
    for (const rec of this.records.values()) counts[rec.status] += 1;
    return counts;
  }

  /** The digest a local (owner, nonce) pair is bound to, if any (terminal records keep their binding). */
  digestForNonce(owner: string, nonce: string): Hex | undefined {
    return this.byOwnerNonce.get(nonceKey(owner, nonce));
  }

  /** Sum of amounts of pending|settling records for (owner, token). */
  reserved(owner: string, token: string): bigint {
    return this.reservedByOwnerToken.get(tokenKey(owner, token)) ?? 0n;
  }

  /** Digests of unsettled (pending|settling) records for (owner, token), oldest first. */
  unsettledFor(owner: string, token: string): Hex[] {
    return this.all()
      .filter(
        (r) =>
          isReservedStatus(r.status) &&
          r.mandate.owner.toLowerCase() === owner.toLowerCase() &&
          r.mandate.token.toLowerCase() === token.toLowerCase(),
      )
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map((r) => r.mandateDigest);
  }

  /** Inserts a new record; throws if the digest is already known. Synchronous. */
  insert(rec: QueueRecord): void {
    if (this.records.has(rec.mandateDigest.toLowerCase())) {
      throw new Error(`store: duplicate record ${rec.mandateDigest}`);
    }
    const event: StoreEvent = { t: 'enq', rec };
    this.apply(event);
    this.append(event);
  }

  /** Patches a record (updatedAt = at); throws for unknown digests. Synchronous. */
  update(digest: string, patch: RecordPatch, at: number): QueueRecord {
    const rec = this.records.get(digest.toLowerCase());
    if (!rec) throw new Error(`store: unknown record ${digest}`);
    const event: StoreEvent = { t: 'upd', digest: rec.mandateDigest, patch, at };
    this.apply(event);
    this.append(event);
    return rec;
  }

  private apply(event: StoreEvent): void {
    if (event.t === 'enq') {
      const rec = event.rec;
      const key = rec.mandateDigest.toLowerCase();
      if (this.records.has(key)) return; // replay of a duplicate: first one wins
      this.records.set(key, rec);
      this.byOwnerNonce.set(nonceKey(rec.mandate.owner, rec.mandate.nonce), rec.mandateDigest);
      if (isReservedStatus(rec.status)) this.addReserved(rec, 1n);
      return;
    }
    const rec = this.records.get(event.digest.toLowerCase());
    if (!rec) return; // update for a record we never saw (tolerated on replay)
    const before = isReservedStatus(rec.status);
    Object.assign(rec, event.patch);
    rec.updatedAt = event.at;
    const after = isReservedStatus(rec.status);
    if (before && !after) this.addReserved(rec, -1n);
    if (!before && after) this.addReserved(rec, 1n);
  }

  private addReserved(rec: QueueRecord, sign: bigint): void {
    const key = tokenKey(rec.mandate.owner, rec.mandate.token);
    const next = (this.reservedByOwnerToken.get(key) ?? 0n) + sign * BigInt(rec.mandate.amount);
    if (next === 0n) this.reservedByOwnerToken.delete(key);
    else this.reservedByOwnerToken.set(key, next);
  }

  private append(event: StoreEvent): void {
    if (!this.path) return;
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  private open(path: string): void {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) return;
    const text = readFileSync(path, 'utf8');
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    const tail = text.slice(lastNewline + 1);

    const lines = complete.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      this.apply(parseEvent(line, i + 1, path));
    }

    if (tail.trim()) {
      // A line without its newline is either a write cut short (drop + repair the
      // file so the next append starts a fresh line) or a complete line a foreign
      // writer forgot to terminate (keep it, and terminate it).
      let event: StoreEvent | undefined;
      try {
        event = parseEvent(tail.trim(), lines.length, path);
      } catch {
        event = undefined;
      }
      if (event) {
        this.apply(event);
        appendFileSync(path, '\n', 'utf8');
      } else {
        truncateSync(path, Buffer.byteLength(complete, 'utf8'));
        this.log(`sp: store ${path}: dropped truncated last line (${tail.length} chars)`);
      }
    }
  }
}
