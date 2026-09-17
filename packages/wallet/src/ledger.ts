import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Append-only JSONL ledger (one JSON object per line). `updateStatus` is the
 * single sanctioned mutation and rewrites the file in place.
 */
export class Ledger {
  constructor(public readonly path: string) {}

  append(entry: LedgerEntry): void {
    const dir = dirname(this.path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Returns [] when the file does not exist yet. Throws on malformed lines. */
  read(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n');
    const entries: LedgerEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch (err) {
        throw new Error(`malformed ledger line ${i + 1} in ${this.path}: ${(err as Error).message}`);
      }
    }
    return entries;
  }

  /** Updates every entry with this mandate digest (status plus optional extra fields); rewrites the file. */
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
    writeFileSync(this.path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  }
}
