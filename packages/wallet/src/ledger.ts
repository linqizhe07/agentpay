import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Eip3009Authorization, Hex } from '@agentpay/core';
import { appendDurableSync, replaceDurableSync } from './durable.js';

/** Bumped when the row shape changes; rows without the current value are refused, not guessed at. */
export const LEDGER_VERSION = 2 as const;

/**
 * One payer-side record of a signed authorization that left the wallet: the
 * authorization and signature (enough to audit or re-present), what the payee
 * answered, and the settlement transaction when one is known.
 */
export interface LedgerEntry {
  v: typeof LEDGER_VERSION;
  kind: 'payment';
  /** Unix seconds, written by the wallet at record time. */
  timestamp: number;
  /**
   * Unix seconds at which the wallet signed. Written with the in_flight line
   * and never patched afterwards (`timestamp` moves with every status update).
   */
  signedAt?: number;
  /** Full URL actually called. */
  url: string;
  /** `url.host` (hostname plus port when non-default). */
  host: string;
  /** 'METHOD /path' (what `report()` groups by). */
  resource: string;
  network: string;
  asset: Address;
  /** Atomic units, decimal string. */
  amount: string;
  payer: Address;
  payee: Address;
  /** The intent mandate whose budget this payment was charged to. */
  intentMandateId: string;
  /** == authorization.nonce; the key `updateStatus()` patches by and what the chain remembers. */
  nonce: Hex;
  /** Unix seconds after which the authorization can no longer be settled. */
  validBefore: number;
  authorization: Eip3009Authorization;
  signature: Hex;
  /** Status of the paid request (0 when the request itself failed). */
  httpStatus: number;
  status:
    | 'settled' // PAYMENT-RESPONSE said success, or reconcile() saw the nonce used on chain
    | 'rejected' // payee answered non-2xx; the signature is out in the world, budget stays reserved
    | 'unknown' // 2xx without a usable PAYMENT-RESPONSE, or the request errored after signing
    | 'expired-unused'; // reconcile(): validBefore passed (chain time) without any on-chain use
  /** Settlement transaction hash when known (from PAYMENT-RESPONSE or the AuthorizationUsed log). */
  transaction?: Hex;
  /** reconcile() confirmed this row's status against the chain. */
  verified?: true;
  error?: string;
}

function parseEntry(line: string, lineNo: number, path: string): LedgerEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`malformed ledger line ${lineNo} in ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`malformed ledger line ${lineNo} in ${path}: not an object`);
  const v = (parsed as { v?: unknown }).v;
  if (v !== LEDGER_VERSION) {
    const looksAep2 = 'mandateDigest' in (parsed as object);
    throw new Error(
      `ledger line ${lineNo} in ${path} is ${looksAep2 ? 'an AEP2-era row (v1)' : `version ${String(v)}`}, this wallet writes v${LEDGER_VERSION}: ` +
        'archive the old ledger (and mandates.json) and start a fresh AGENTPAY_HOME; old rows are not converted',
    );
  }
  return parsed as LedgerEntry;
}

/**
 * Append-only JSONL ledger (one JSON object per line). `updateStatus` is the
 * single sanctioned mutation and rewrites the file through a temp file plus
 * rename, so a crash mid-rewrite leaves the old ledger or the new one, never a
 * torn one. Only a truncated LAST line (an append cut short by a crash) is
 * tolerated: `read()` ignores it, and the write paths get rid of it (`append()`
 * truncates it away before writing so it never glues a new line onto it;
 * `updateStatus()` rewrites the file without it). A reader never modifies the
 * file, so `report()` in a second process cannot destroy an append the wallet
 * process is in the middle of. Any other malformed line throws.
 *
 * Every write is fsynced: since the budget counters are rebuilt from this file
 * on load, a line lost to a power cut is not a stale report but a payment that
 * no longer counts against its limit.
 */
export class Ledger {
  private writeSeq = 0;

  constructor(
    public readonly path: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  append(entry: LedgerEntry): void {
    const dir = dirname(this.path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    this.repairTail();
    appendDurableSync(this.path, `${JSON.stringify(entry)}\n`);
  }

  /**
   * Returns [] when the file does not exist yet. Throws on malformed lines,
   * except for a line without its newline at the very end: a complete one (a
   * foreign writer forgot to terminate it) is kept, a torn one is ignored.
   * Only with `repair` (the append path) is the file touched: the complete
   * line is terminated, the torn one truncated back to the last newline.
   */
  read(opts: { repair?: boolean } = {}): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
    const tail = text.slice(lastNewline + 1);

    const lines = complete.split('\n');
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      entries.push(parseEntry(line, i + 1, this.path));
    }

    if (tail.trim()) {
      let entry: LedgerEntry | undefined;
      try {
        entry = parseEntry(tail.trim(), lines.length, this.path);
      } catch {
        entry = undefined;
      }
      if (entry) {
        entries.push(entry);
        if (opts.repair) appendFileSync(this.path, '\n', 'utf8');
      } else if (opts.repair) {
        truncateSync(this.path, Buffer.byteLength(complete, 'utf8'));
        this.log(`wallet: ledger ${this.path}: dropped truncated last line (${tail.length} chars)`);
      } else {
        this.log(`wallet: ledger ${this.path}: ignoring truncated last line (${tail.length} chars; dropped on the next append)`);
      }
    }
    return entries;
  }

  /** Updates every entry with this nonce (status plus optional extra fields); rewrites the file atomically. */
  updateStatus(nonce: Hex, status: LedgerEntry['status'], patch?: Partial<LedgerEntry>): void {
    const entries = this.read();
    let hit = false;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].nonce.toLowerCase() === nonce.toLowerCase()) {
        entries[i] = { ...entries[i], ...patch, status };
        hit = true;
      }
    }
    if (!hit) throw new Error(`no ledger entry with nonce ${nonce} in ${this.path}`);
    const tmp = `${this.path}.${process.pid}.${++this.writeSeq}.tmp`;
    replaceDurableSync(this.path, tmp, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }

  /**
   * Makes sure the file is absent, empty, or newline-terminated before an
   * append, so a torn last line never gets a new line glued onto it. The common
   * case costs one stat and one byte; only an unterminated tail takes the full
   * read() path (keep and terminate a complete line, drop a torn one). This is
   * the one place a torn tail is truncated: `updateStatus()` drops it by
   * rewriting the whole file, and plain readers leave the file alone.
   */
  private repairTail(): void {
    if (!existsSync(this.path)) return;
    const { size } = statSync(this.path);
    if (size === 0) return;
    const last = Buffer.alloc(1);
    const fd = openSync(this.path, 'r');
    try {
      readSync(fd, last, 0, 1, size - 1);
    } finally {
      closeSync(fd);
    }
    if (last[0] !== 0x0a) this.read({ repair: true });
  }
}
