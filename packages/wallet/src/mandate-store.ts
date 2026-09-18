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
}

/**
 * A budget the payer approved once (EIP-712 signed, purely off-chain) that the
 * agent may spend against without further prompts. `spentAmount` counts
 * committed mandates (enqueued or settled); `pendingSpentAmount` is reserved for
 * signed mandates whose fate is not known yet. Both are persisted so every
 * process sharing the store sees the same remaining budget, but the ledger is
 * the source of truth: MandateWallet recomputes them from it on construction.
 */
export interface IntentMandate {
  /** 'im_…' */
  id: string;
  naturalLanguage: string;
  category?: string;
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

/** Off-chain credential: nothing verifies it on-chain, so no verifyingContract. */
export const INTENT_DOMAIN = { name: 'AEP2AgentWallet', version: '1' } as const;

export const INTENT_MANDATE_TYPES = {
  IntentMandate: [
    { name: 'id', type: 'string' },
    { name: 'naturalLanguage', type: 'string' },
    { name: 'limitAmount', type: 'uint256' },
    { name: 'validFrom', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'hostAllowlist', type: 'string' },
    { name: 'category', type: 'string' },
  ],
} as const;

export type IntentMandateStruct = Pick<
  IntentMandate,
  'id' | 'naturalLanguage' | 'limitAmount' | 'validFrom' | 'validUntil' | 'hostAllowlist' | 'category'
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
  const limit = parseAmount(input.limitAmount);
  const perCall = input.perCallMax !== undefined ? parseAmount(input.perCallMax) : undefined;
  if (perCall !== undefined && perCall > limit) {
    throw new RangeError('perCallMax cannot exceed limitAmount');
  }
  const draft: IntentMandate = {
    id: newId('im'),
    naturalLanguage: input.naturalLanguage.trim(),
    ...(input.category !== undefined ? { category: input.category } : {}),
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

interface StoreFile {
  version: 1;
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
        const parsed = JSON.parse(raw) as Partial<StoreFile>;
        if (parsed.version !== undefined && parsed.version !== 1) {
          throw new Error(`unsupported mandate store version ${JSON.stringify(parsed.version)} at ${path} (expected 1)`);
        }
        if (!Array.isArray(parsed.mandates)) throw new Error(`malformed mandate store at ${path}`);
        for (const m of parsed.mandates) this.byId.set(m.id, m);
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
    const file: StoreFile = { version: 1, mandates: this.list() };
    const tmp = `${this.path}.${process.pid}.${++this.saveSeq}.tmp`;
    replaceDurableSync(this.path, tmp, `${JSON.stringify(file, null, 2)}\n`);
  }
}
