import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Address, Hex, Mandate, SpReceipt } from '@agentpay/core';

/**
 * One payer-side record of a signed mandate that left the wallet: the full
 * mandate and signature (enough to audit or re-present), what the payee
 * answered, and the settlement processor's receipt when one verified.
 */
export interface LedgerEntry {
  kind: 'payment';
  /** Unix seconds, written by the wallet at record time. */
  timestamp: number;
  /** Full URL actually called. */
  url: string;
  /** `url.host` (hostname plus port when non-default). */
  host: string;
  /** 'METHOD /path' offer identifier. */
  resource: string;
  network: string;
  asset: Address;
  /** Atomic units, decimal string. */
  amount: string;
  payer: Address;
  payee: Address;
  walletContract: Address;
  /** The intent mandate whose budget this payment was charged to. */
  intentMandateId: string;
  mandate: Mandate;
  payerSig: Hex;
  mandateDigest: Hex;
  /** Present when the payee returned one (valid or not; see `status`/`error`). */
  spReceipt?: SpReceipt;
  /** Status of the paid request (0 when the request itself failed). */
  httpStatus: number;
  status:
    | 'enqueued' // 2xx with a verified SP receipt (or a missing one when receipts are not required)
    | 'settled' // reconcile() saw the nonce consumed on-chain
    | 'rejected' // payee answered non-2xx; the signature is out in the world, budget stays reserved
    | 'unknown' // 2xx but the receipt was missing/invalid, or the request errored after signing
    | 'expired-unused'; // reconcile(): deadline passed without any on-chain use
  settledTx?: Hex;
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
  return parsed as LedgerEntry;
}

/**
 * Append-only JSONL ledger (one JSON object per line). `updateStatus` is the
 * single sanctioned mutation and rewrites the file through a temp file plus
 * rename, so a crash mid-rewrite leaves the old ledger or the new one, never a
 * torn one. Only a truncated LAST line (an append cut short by a crash) is
 * tolerated: `read()` drops it and repairs the file, and `append()` never glues
 * a new line onto it. Any other malformed line throws.
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
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /**
   * Returns [] when the file does not exist yet. Throws on malformed lines,
   * except for a line without its newline at the very end: a complete one (a
   * foreign writer forgot to terminate it) is kept and terminated, a torn one
   * is dropped and the file truncated back to the last newline.
   */
  read(): LedgerEntry[] {
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
        appendFileSync(this.path, '\n', 'utf8');
      } else {
        truncateSync(this.path, Buffer.byteLength(complete, 'utf8'));
        this.log(`wallet: ledger ${this.path}: dropped truncated last line (${tail.length} chars)`);
      }
    }
    return entries;
  }

  /** Updates every entry with this mandate digest (status plus optional extra fields); rewrites the file atomically. */
  updateStatus(digest: Hex, status: LedgerEntry['status'], patch?: Partial<LedgerEntry>): void {
    const entries = this.read();
    let hit = false;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].mandateDigest.toLowerCase() === digest.toLowerCase()) {
        entries[i] = { ...entries[i], ...patch, status };
        hit = true;
      }
    }
    if (!hit) throw new Error(`no ledger entry with mandateDigest ${digest} in ${this.path}`);
    const tmp = `${this.path}.${process.pid}.${++this.writeSeq}.tmp`;
    writeFileSync(tmp, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    renameSync(tmp, this.path);
  }

  /**
   * Makes sure the file is absent, empty, or newline-terminated before an
   * append, so a torn last line never gets a new line glued onto it. The common
   * case costs one stat and one byte; only an unterminated tail takes the full
   * read() path (keep a complete line, drop a torn one).
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
    if (last[0] !== 0x0a) this.read();
  }
}
