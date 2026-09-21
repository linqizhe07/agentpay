import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { newId, parseAmount, type Address, type Hex, type TypedDataSigner } from '@agentpay/core';
import { replaceDurableSync } from './durable.js';

/** What a human (or an agent drafting on their behalf) supplies to create an intent mandate. */
export interface IntentMandateInput {
  /** Purpose in plain words, e.g. "market data for the ETH report". */
  naturalLanguage: string;
  /** Total budget: '$5' / '5.00' style price or bare atomic units ('5000000'). */
  limitAmount: string;
  /** Validity window from creation; at most one year. */
  validForSeconds: number;
  /** Hosts this budget may pay (see hosts.ts for the pattern syntax). */
  hostAllowlist: string[];
  category?: string;
  /** Per-payment cap, same formats as limitAmount. */
  perCallMax?: string;
  maxCallsPerMinute?: number;
  /**
   * Only through MandateWallet.delegateIntentMandate (which validates both
   * against the parent); createIntentMandate refuses input carrying them.
   */
  parentId?: string;
  holder?: string;
}

/**
 * Who may spend a mandate. Absent = the principal's alone. The vocabulary is
 * the host's to resolve (it derives the caller from facts it owns, never from
 * the model's arguments); the wallet only filters on it:
 *   - 'session:<id>'           one session
 *   - 'children:<sessionId>'   the direct child sessions of that session
 *   - 'bot:<id>'               a bot preset (kept for hosts that want it)
 */
export const HOLDER_RE = /^(session|children|bot):(\S+)$/;

export type Holder = { kind: 'session' | 'children' | 'bot'; id: string };

export function parseHolder(holder: string): Holder | undefined {
  const m = HOLDER_RE.exec(holder);
  return m ? { kind: m[1] as Holder['kind'], id: m[2] } : undefined;
}

export function isHolder(holder: unknown): holder is string {
  return typeof holder === 'string' && HOLDER_RE.test(holder);
}

/**
 * A budget the payer approved once (EIP-712 signed, purely off-chain) that the
 * agent may spend against without further prompts. `spentAmount` counts
 * committed mandates (enqueued or settled); `pendingSpentAmount` is reserved for
 * signed mandates whose fate is not known yet. Both are persisted so every
 * process sharing the store sees the same remaining budget, but the ledger is
 * the source of truth: MandateWallet recomputes them from it on construction.
 *
 * A mandate with a `parentId` is a sub-budget delegated from its parent: its
 * spend counts against itself and every ancestor (a cap, not a reservation —
 * siblings compete for the parent's remaining budget), and the gate applies
 * every ancestor's full policy on each payment. `holder` names who may spend
 * it (see HOLDER_RE); both are in the signed struct.
 */
export interface IntentMandate {
  /** 'im_…' */
  id: string;
  naturalLanguage: string;
  category?: string;
  parentId?: string;
  holder?: string;
  currency: 'USDC';
  /** Atomic units, decimal string. */
  limitAmount: string;
  /** Atomic units, decimal string. */
  perCallMax?: string;
  maxCallsPerMinute?: number;
  hostAllowlist: string[];
  /** Unix seconds (inclusive). */
  validFrom: number;
  /** Unix seconds (exclusive). */
  validUntil: number;
  spentAmount: string;
  pendingSpentAmount: string;
  status: 'draft' | 'signed';
  isEnabled: boolean;
  /** EIP-712 hash of the mandate struct (what approveIntentMandate signs). */
  mandateHash: Hex;
  signature?: Hex;
  createdAt: number;
  signedAt?: number;
}

export const MAX_VALID_FOR_SECONDS = 31_536_000; // one year

/**
 * Off-chain credential: nothing verifies it on-chain, so no verifyingContract.
 * Version 2 added parentId and holder to the struct; a v1 signature cannot
 * verify under it, and re-signing old mandates with the payer key would
 * manufacture approvals, so a v1 store is refused (see IntentMandateStore).
 */
export const INTENT_DOMAIN = { name: 'agentpay', version: '2' } as const;

export const INTENT_MANDATE_TYPES = {
  IntentMandate: [
    { name: 'id', type: 'string' },
    { name: 'naturalLanguage', type: 'string' },
    { name: 'limitAmount', type: 'uint256' },
    { name: 'validFrom', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'hostAllowlist', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'parentId', type: 'string' },
    { name: 'holder', type: 'string' },
  ],
} as const;

export type IntentMandateStruct = Pick<
  IntentMandate,
  'id' | 'naturalLanguage' | 'limitAmount' | 'validFrom' | 'validUntil' | 'hostAllowlist' | 'category' | 'parentId' | 'holder'
>;

export function intentMandateTypedData(chainId: number, m: IntentMandateStruct) {
  return {
    domain: { name: INTENT_DOMAIN.name, version: INTENT_DOMAIN.version, chainId },
    types: INTENT_MANDATE_TYPES,
    primaryType: 'IntentMandate' as const,
    message: {
      id: m.id,
      naturalLanguage: m.naturalLanguage,
      limitAmount: BigInt(m.limitAmount),
      validFrom: BigInt(m.validFrom),
      validUntil: BigInt(m.validUntil),
      hostAllowlist: m.hostAllowlist.join(','),
      category: m.category ?? '',
      parentId: m.parentId ?? '',
      holder: m.holder ?? '',
    },
  };
}

export function intentMandateHash(chainId: number, m: IntentMandateStruct): Hex {
  return hashTypedData(intentMandateTypedData(chainId, m));
}

export async function signIntentMandate(
  account: TypedDataSigner,
  chainId: number,
  m: IntentMandateStruct,
): Promise<Hex> {
  return account.signTypedData(intentMandateTypedData(chainId, m));
}

export async function recoverIntentMandateSigner(
  chainId: number,
  m: IntentMandateStruct,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...intentMandateTypedData(chainId, m), signature });
}

function normalizeHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) throw new TypeError('hostAllowlist must be an array of host patterns');
  const out = hosts
    .map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : ''))
    .filter((h) => h.length > 0);
  if (out.length === 0) throw new TypeError('hostAllowlist must contain at least one host pattern');
  return [...new Set(out)];
}

/** Validates and normalizes user input into a draft IntentMandate (atomic amounts, absolute window). */
export function buildIntentMandate(
  input: IntentMandateInput,
  opts: { chainId: number; now: number },
): IntentMandate {
  if (typeof input.naturalLanguage !== 'string' || input.naturalLanguage.trim().length === 0) {
    throw new TypeError('naturalLanguage must be a non-empty string');
  }
  if (
    typeof input.validForSeconds !== 'number' ||
    !Number.isInteger(input.validForSeconds) ||
    input.validForSeconds <= 0 ||
    input.validForSeconds > MAX_VALID_FOR_SECONDS
  ) {
    throw new RangeError(`validForSeconds must be an integer in 1..${MAX_VALID_FOR_SECONDS}`);
  }
  if (
    input.maxCallsPerMinute !== undefined &&
    (!Number.isInteger(input.maxCallsPerMinute) || input.maxCallsPerMinute <= 0)
  ) {
    throw new RangeError('maxCallsPerMinute must be a positive integer');
  }
  if (input.category !== undefined && typeof input.category !== 'string') {
    throw new TypeError('category must be a string');
  }
  if (input.parentId !== undefined && (typeof input.parentId !== 'string' || input.parentId.trim().length === 0)) {
    throw new TypeError('parentId must be a non-empty string');
  }
  if (input.holder !== undefined && !isHolder(input.holder)) {
    throw new TypeError("holder must be 'session:<id>', 'children:<sessionId>' or 'bot:<id>'");
  }
  const limit = parseAmount(input.limitAmount);
  const perCall = input.perCallMax !== undefined ? parseAmount(input.perCallMax) : undefined;
  if (perCall !== undefined && perCall > limit) {
    throw new RangeError('perCallMax cannot exceed limitAmount');
  }
  const draft: IntentMandate = {
    id: newId('im'),
    naturalLanguage: input.naturalLanguage.trim(),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId.trim() } : {}),
    ...(input.holder !== undefined ? { holder: input.holder } : {}),
    currency: 'USDC',
    limitAmount: limit.toString(),
    ...(perCall !== undefined ? { perCallMax: perCall.toString() } : {}),
    ...(input.maxCallsPerMinute !== undefined ? { maxCallsPerMinute: input.maxCallsPerMinute } : {}),
    hostAllowlist: normalizeHosts(input.hostAllowlist),
    validFrom: opts.now,
    validUntil: opts.now + input.validForSeconds,
    spentAmount: '0',
    pendingSpentAmount: '0',
    status: 'draft',
    isEnabled: true,
    mandateHash: '0x' as Hex,
    createdAt: opts.now,
  };
  draft.mandateHash = intentMandateHash(opts.chainId, draft);
  return draft;
}

/** Bumped with INTENT_DOMAIN: a store's mandates are signed under the domain its version names. */
export const STORE_VERSION = 2 as const;

interface StoreFile {
  version: typeof STORE_VERSION;
  mandates: IntentMandate[];
}

/**
 * Intent mandates plus their budget counters. Memory-only when constructed
 * without a path; otherwise loaded from `path` on construction and written
 * back by `save()` (fsynced temp file + rename, so readers never see a torn
 * file and a power cut cannot leave it emptier than the ledger).
 */
export class IntentMandateStore {
  private readonly byId = new Map<string, IntentMandate>();
  private saveSeq = 0;

  constructor(public readonly path?: string) {
    if (path && existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as { version?: unknown; mandates?: unknown };
        if (parsed.version === undefined || parsed.version === 1) {
          // Its mandates were signed under the v1 domain (AEP2AgentWallet/1,
          // no parentId/holder); nothing here can verify them, and re-signing
          // with the payer key would manufacture approvals nobody gave.
          throw new Error(
            `mandate store ${path} is version ${parsed.version === undefined ? '1 (no version field)' : '1'}, which predates the v${STORE_VERSION} ` +
              `intent domain (${INTENT_DOMAIN.name}/${INTENT_DOMAIN.version}): archive it (and the ledger) and start a fresh AGENTPAY_HOME; ` +
              'old mandates are not converted, recreate them',
          );
        }
        if (parsed.version !== STORE_VERSION) {
          throw new Error(`unsupported mandate store version ${JSON.stringify(parsed.version)} at ${path} (expected ${STORE_VERSION})`);
        }
        if (!Array.isArray(parsed.mandates)) throw new Error(`malformed mandate store at ${path}`);
        for (const m of parsed.mandates as IntentMandate[]) this.byId.set(m.id, m);
      }
    }
  }

  list(): IntentMandate[] {
    return [...this.byId.values()];
  }

  get(id: string): IntentMandate | undefined {
    return this.byId.get(id);
  }

  /** Inserts or replaces the record in memory; call save() to persist. */
  upsert(m: IntentMandate): void {
    this.byId.set(m.id, m);
  }

  save(): void {
    if (!this.path) return;
    const dir = dirname(this.path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    const file: StoreFile = { version: STORE_VERSION, mandates: this.list() };
    const tmp = `${this.path}.${process.pid}.${++this.saveSeq}.tmp`;
    replaceDurableSync(this.path, tmp, `${JSON.stringify(file, null, 2)}\n`);
  }
}
