import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import {
  BLOCK_TIME_SECONDS,
  EIP3009_ABI,
  PolicyViolation,
  WireError,
  chainIdFromNetwork,
  parseAmount,
  paymentModelContext,
  type Address,
  type AssetDomain,
  type Eip3009Authorization,
  type Hex,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type PolicyReason,
  type SettleResponse,
} from '@agentpay/core';
import { hostAllowed, hostCandidates, hostPatternWithin, urlHostCandidates } from './hosts.js';
import { DEFAULT_MAX_AUTHORIZATION_VALIDITY, isPayableOffer } from './offers.js';
import { LEDGER_VERSION, Ledger, validatePaymentContext, type LedgerEntry, type PaymentContext } from './ledger.js';
import {
  IntentMandateStore,
  buildIntentMandate,
  isHolder,
  recoverIntentMandateSigner,
  signIntentMandate,
  type IntentMandate,
  type IntentMandateInput,
} from './mandate-store.js';
import {
  PRINCIPAL,
  chainRejection,
  holderSetFor,
  pickRejection,
  pruneWindow,
  remainingOf,
  type Caller,
  type PolicyQuery,
  type Rejection,
} from './policy.js';

export interface MandateWalletCaps {
  /** Hard cap per single payment, atomic units, independent of any mandate. */
  perCallMaxAtomic?: bigint;
  /** Sliding 60s window over payment attempts across all mandates. */
  maxCallsPerMinute?: number;
  /**
   * Offers demanding an authorization valid for longer than this are refused
   * (timeout_too_long): a failed call ties up its budget until the
   * authorization expires. Default 300.
   */
  maxAuthorizationValiditySeconds?: number;
  /** balance() logs a warning above this many atomic units: keep a small float in the EOA. */
  floatWarnAtomic?: bigint;
}

export interface MandateWalletOptions {
  /** Payer EOA private key (or pass `account`). */
  key?: Hex;
  account?: PrivateKeyAccount;
  /** Needed by balance() and reconcile() only; fetch() never touches the chain. */
  rpcUrl?: string;
  /** The EIP-3009 token this wallet pays with (USDC). */
  token: Address;
  /** Its EIP-712 domain; offers naming another domain for the token are refused. */
  assetDomain: AssetDomain;
  /** CAIP-2 network, e.g. 'eip155:31337'. */
  network: string;
  /** mandates.json; omitted = in-memory store. */
  mandatesPath?: string;
  /** ledger.jsonl (append-only). */
  ledgerPath: string;
  caps?: MandateWalletCaps;
  /** Re-presenting the same signed header after a transport error. Default 2 attempts, 1000 ms apart. */
  transportRetries?: { attempts: number; delayMs: number };
  /** Injectable clock (unix seconds). */
  now?: () => number;
  /** Injectable fetch. */
  fetch?: typeof fetch;
  /** Receives one line per repair the wallet makes to its files on load and per warning. Default: discard. */
  log?: (line: string) => void;
  /**
   * fetch() refuses a URL before its first request unless a mandate in the
   * caller's set names its host (host_not_allowed; no_held_mandate when the
   * set is empty). For a host process whose only HTTP client this is: without
   * it the wallet fetches any URL and only the 402 path meets the allowlist.
   * Default false.
   */
  requireMandateHost?: boolean;
  /**
   * Take `<dir of mandatesPath>/wallet.lock` (this pid) for the life of this
   * wallet; refuse to start when a live pid holds it (see lockedBy). A store
   * is loaded once and rewritten from memory, so a second process on the same
   * home would silently drop what the first wrote. Released by dispose().
   */
  lock?: boolean;
}

export interface FetchOptions {
  /** Charge this intent mandate instead of auto-selecting one. */
  mandateId?: string;
  /** Intent Mode: when an offer for this resource is cached, attach the payment to the first request. */
  prepay?: boolean;
  /** Attribution stored on the ledger row (validated: known string fields, each <= 256 chars). */
  context?: PaymentContext;
  /** Whose mandates may pay (see Caller); default the principal (mandates without a holder). */
  caller?: Caller;
}

export interface PolicyDenial {
  reason: string;
  url: string;
  mandateId?: string;
  timestamp: number;
}

export interface SpendReport {
  address: Address;
  token: Address;
  network: string;
  mandates: Array<
    Pick<
      IntentMandate,
      | 'id'
      | 'naturalLanguage'
      | 'limitAmount'
      | 'spentAmount'
      | 'pendingSpentAmount'
      | 'validUntil'
      | 'isEnabled'
      | 'status'
      | 'hostAllowlist'
      | 'parentId'
      | 'holder'
    > & {
      /** effectiveRemaining(): the tightest remaining budget on the chain, which is what this mandate can actually spend. */
      remainingAmount: string;
    }
  >;
  /**
   * `spent`/`pending` sum root mandates only (a child's spend is already in
   * its root's counters), so they equal the ledger's sums.
   */
  totals: {
    /** Atomic units committed (settled, or delivered without a usable settlement), decimal string. */
    spent: string;
    /** Atomic units reserved for signed authorizations of unknown fate, decimal string. */
    pending: string;
    settled: number;
    rejected: number;
    unknown: number;
    expiredUnused: number;
  };
  byHost: Record<string, string>;
  byResource: Record<string, string>;
  /** Spend (settled + unknown rows) by context.channel; rows without one under ''. */
  byChannel: Record<string, string>;
  /** Same, by context.session. */
  bySession: Record<string, string>;
  policyDenials: PolicyDenial[];
}

export interface EligibilityResult {
  /** Sorted by earliest validUntil (spend the budget that expires first). */
  eligible: IntentMandate[];
  rejected: { id: string; reason: PolicyReason; detail?: Record<string, unknown> }[];
}

export interface ReconcileResult {
  settled: Hex[];
  expiredUnused: Hex[];
  stillPending: Hex[];
  /** Rows that already said settled and were confirmed on chain. */
  verified: Hex[];
}

/** Non-standard response headers fetch() adds so a caller can find the ledger row of a paid call. */
export const NONCE_HEADER = 'x-agentpay-nonce';
export const LEDGER_STATUS_HEADER = 'x-agentpay-ledger-status';

/** A delegated budget lives at most this long past its creation (24 h), whatever its parent allows. */
export const MAX_DELEGATED_VALIDITY_SECONDS = 86_400;
/** The lock file `lock: true` writes next to mandates.json. */
export const LOCK_FILE = 'wallet.lock';

/**
 * The pid holding `<dir>/wallet.lock` when that process is alive; undefined
 * when there is no lock or its pid is dead (a stale lock from a crash is
 * removed on the way). What a CLI checks before mutating a home a long-lived
 * wallet process owns.
 */
export function lockedBy(dir: string): number | undefined {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, owned by someone else. Anything but ESRCH counts as alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const DEFAULT_TRANSPORT_RETRIES = { attempts: 2, delayMs: 1000 };
/** Seconds before validBefore at which re-presenting a signed header is pointless. */
const REPRESENT_MARGIN_SECONDS = 10;
/** Blocks scanned for the AuthorizationUsed log beyond what the signing time implies. */
const LOG_LOOKBACK_SLACK_BLOCKS = 100;
const TX_RE = /^0x[0-9a-f]{64}$/i;

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isSpendStatus = (s: LedgerEntry['status']): boolean => s === 'settled' || s === 'unknown';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Payer-side x402 wallet: a fetch wrapper that answers 402 offers by signing a
 * single-use EIP-3009 authorization under an approved intent mandate's
 * budget, records the settlement the payee reports, keeps a JSONL ledger and
 * reconciles it against the chain. The protocol itself is the official
 * x402 client's; this class adds the budget around it.
 *
 * Invariant: no signature is produced unless the policy gate passed and the
 * budget was reserved — in one synchronous step, so concurrent fetch() calls
 * cannot overshoot a limit.
 */
export class MandateWallet {
  readonly address: Address;
  readonly token: Address;
  readonly assetDomain: AssetDomain;
  readonly network: string;
  readonly chainId: number;

  private readonly account: PrivateKeyAccount;
  private readonly rpcUrl?: string;
  private publicClientCache?: PublicClient<Transport, Chain>;
  private readonly client: x402Client;
  private readonly http: x402HTTPClient;
  private readonly store: IntentMandateStore;
  private readonly ledger: Ledger;
  private readonly caps: Required<Pick<MandateWalletCaps, 'maxAuthorizationValiditySeconds'>> & MandateWalletCaps;
  private readonly transportRetries: { attempts: number; delayMs: number };
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly requireMandateHost: boolean;
  private lockPath?: string;

  /** Cached 402 offers keyed by 'METHOD origin/path' (Intent Mode source). */
  private readonly offers = new Map<string, PaymentRequired>();
  /** Unix-second timestamps of gate-passing attempts (wallet-wide rate limit). */
  private attempts: number[] = [];
  /** Same, per intent mandate (a chain member's window sees its descendants' attempts too). */
  private readonly mandateAttempts = new Map<string, number[]>();
  private readonly policyDenials: PolicyDenial[] = [];
  /** Mandates whose broken chain (missing parent, cycle) was already logged. */
  private readonly chainWarned = new Set<string>();

  constructor(opts: MandateWalletOptions) {
    if (opts.account) this.account = opts.account;
    else if (opts.key) this.account = privateKeyToAccount(opts.key);
    else throw new TypeError('MandateWallet needs `key` or `account`');
    if (!opts.assetDomain?.name || !opts.assetDomain?.version) throw new TypeError('MandateWallet needs `assetDomain` { name, version }');
    this.address = this.account.address;
    this.token = opts.token;
    this.assetDomain = { name: opts.assetDomain.name, version: opts.assetDomain.version };
    this.network = opts.network;
    this.chainId = chainIdFromNetwork(opts.network);
    this.rpcUrl = opts.rpcUrl;
    this.log = opts.log ?? (() => {});
    this.requireMandateHost = opts.requireMandateHost ?? false;
    if (opts.lock) {
      if (!opts.mandatesPath) throw new TypeError('MandateWallet: `lock` needs `mandatesPath` (the lock lives next to it)');
      this.lockPath = this.takeLock(dirname(opts.mandatesPath));
    }
    try {
      this.store = new IntentMandateStore(opts.mandatesPath);
      this.ledger = new Ledger(opts.ledgerPath, this.log);
      this.rebuildBudgets();
    } catch (err) {
      this.dispose(); // a refused store must not leave the home locked
      throw err;
    }
    this.caps = {
      ...opts.caps,
      maxAuthorizationValiditySeconds: opts.caps?.maxAuthorizationValiditySeconds ?? DEFAULT_MAX_AUTHORIZATION_VALIDITY,
    };
    this.transportRetries = opts.transportRetries ?? DEFAULT_TRANSPORT_RETRIES;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const f = opts.fetch;
    this.fetchImpl = f ? (input, init) => f(input, init) : (input, init) => globalThis.fetch(input, init);

    // The official client signs; spend controls are ours (the policy gate), so
    // its own defaults (which would refuse a non-default asset and cap $1 per
    // payment) are off. The scheme is EIP-3009 only: signing needs no RPC.
    this.client = new x402Client().setSpendControls(false);
    registerExactEvmScheme(this.client, { signer: this.account, networks: [this.network as `${string}:${string}`] });
    this.http = new x402HTTPClient(this.client);
  }

  // ------------------------------------------------------------------ chain

  private publicClient(): PublicClient<Transport, Chain> {
    if (this.publicClientCache) return this.publicClientCache;
    if (!this.rpcUrl) throw new Error('MandateWallet: rpcUrl is required for balance() and reconcile()');
    // A concrete chain makes viem reject an RPC that serves a different chain
    // (ChainMismatchError) instead of reading the wrong network's state.
    const chain = defineChain({
      id: this.chainId,
      name: this.network,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    });
    // No transport retries: reconcile() must fail fast when the RPC is down.
    this.publicClientCache = createPublicClient({ chain, transport: http(this.rpcUrl, { retryCount: 0 }), pollingInterval: 250 });
    return this.publicClientCache;
  }

  /** The payer's token balance (what settlements are pulled from). */
  async balance(): Promise<bigint> {
    const balance = await this.publicClient().readContract({
      address: this.token,
      abi: EIP3009_ABI,
      functionName: 'balanceOf',
      args: [this.address],
    });
    if (this.caps.floatWarnAtomic !== undefined && balance > this.caps.floatWarnAtomic) {
      this.log(
        `wallet: ${this.address} holds ${balance} atomic units of ${this.token}, above the float warning of ${this.caps.floatWarnAtomic}: ` +
          'whoever holds this key can move all of it; keep a small float here and top it up from a cold key',
      );
    }
    return balance;
  }

  // -------------------------------------------------------- intent mandates

  /**
   * Creates a draft root mandate (nothing can be spent against it until
   * approveIntentMandate). Refuses parentId/holder: a child is only ever made
   * by delegateIntentMandate, which bounds it by its parent.
   */
  async createIntentMandate(input: IntentMandateInput, opts: { approve?: boolean } = {}): Promise<IntentMandate> {
    if (input.parentId !== undefined || input.holder !== undefined) {
      throw new TypeError('createIntentMandate makes root mandates only: use delegateIntentMandate(parentId, input, holder) for a sub-budget');
    }
    const draft = buildIntentMandate(input, { chainId: this.chainId, now: this.now() });
    this.store.upsert(draft);
    this.store.save();
    return opts.approve ? this.approveIntentMandate(draft.id) : draft;
  }

  /**
   * A sub-budget under `parentId`, held by `holder`, created signed in one
   * step: the human approved the parent, and the child cannot exceed it —
   * limit <= effectiveRemaining(parent) (a cap: siblings compete for the
   * parent's remaining budget), validity <= the parent's and <= 24 h (a
   * RangeError, not a silent clamp, so the delegator learns the bound),
   * every host pattern within the parent's (hostPatternWithin), perCallMax <=
   * the parent's (inherited when absent), category inherited when absent.
   * The gate re-checks every ancestor's full policy on each payment anyway;
   * these bounds keep the child honest at creation. A cycle is impossible:
   * the parent exists before the child does.
   */
  async delegateIntentMandate(parentId: string, input: IntentMandateInput, holder: string): Promise<IntentMandate> {
    if (input.parentId !== undefined || input.holder !== undefined) {
      throw new TypeError('delegateIntentMandate takes parentId and holder as arguments, not in the input');
    }
    if (!isHolder(holder)) throw new TypeError("holder must be 'session:<id>', 'children:<sessionId>' or 'bot:<id>'");
    const parent = this.mustGet(parentId);
    const now = this.now();
    if (parent.status !== 'signed' || !parent.signature) throw new Error(`parent mandate ${parentId} is not signed`);
    if (!parent.isEnabled) throw new Error(`parent mandate ${parentId} is disabled`);
    if (now < parent.validFrom || now >= parent.validUntil) throw new Error(`parent mandate ${parentId} is outside its validity window`);

    const remaining = this.effectiveRemaining(parentId);
    const limit = parseAmount(input.limitAmount);
    if (limit > remaining) {
      throw new RangeError(`limitAmount ${limit} exceeds the parent's effective remaining budget ${remaining} (atomic units)`);
    }
    const maxValidity = Math.min(parent.validUntil - now, MAX_DELEGATED_VALIDITY_SECONDS);
    if (typeof input.validForSeconds !== 'number' || !Number.isInteger(input.validForSeconds) || input.validForSeconds <= 0) {
      throw new RangeError(`validForSeconds must be an integer in 1..${maxValidity}`);
    }
    if (input.validForSeconds > maxValidity) {
      throw new RangeError(
        `validForSeconds ${input.validForSeconds} exceeds ${maxValidity}: a delegated budget ends with its parent (${parent.validUntil}) ` +
          `and within ${MAX_DELEGATED_VALIDITY_SECONDS}s of its creation`,
      );
    }
    if (!Array.isArray(input.hostAllowlist)) throw new TypeError('hostAllowlist must be an array of host patterns');
    for (const p of input.hostAllowlist) {
      if (typeof p !== 'string' || !hostPatternWithin(parent.hostAllowlist, p)) {
        throw new RangeError(`host pattern ${JSON.stringify(p)} is not within the parent's allowlist [${parent.hostAllowlist.join(', ')}]`);
      }
    }
    let perCallMax = input.perCallMax !== undefined ? parseAmount(input.perCallMax) : undefined;
    if (parent.perCallMax !== undefined) {
      const parentCap = BigInt(parent.perCallMax);
      if (perCallMax === undefined) perCallMax = parentCap < limit ? parentCap : limit; // inherited; the limit already bounds it
      else if (perCallMax > parentCap) throw new RangeError(`perCallMax ${perCallMax} exceeds the parent's ${parentCap} (atomic units)`);
    }
    const child = buildIntentMandate(
      {
        ...input,
        ...(perCallMax !== undefined ? { perCallMax: perCallMax.toString() } : {}),
        ...(input.category === undefined && parent.category !== undefined ? { category: parent.category } : {}),
        parentId,
        holder,
      },
      { chainId: this.chainId, now },
    );
    // Signed before it is stored: a signing failure leaves no draft behind.
    const signature = await signIntentMandate(this.account, this.chainId, child);
    const signed: IntentMandate = { ...child, status: 'signed', signature, signedAt: this.now() };
    this.store.upsert(signed);
    this.store.save();
    return signed;
  }

  /** The human's one-time approval: signs the EIP-712 IntentMandate with the payer key. */
  async approveIntentMandate(id: string): Promise<IntentMandate> {
    const m = this.mustGet(id);
    if (m.status === 'signed' && m.signature) return m;
    const signature = await signIntentMandate(this.account, this.chainId, m);
    return this.patchMandate(id, { status: 'signed', signature, signedAt: this.now() });
  }

  setEnabled(id: string, enabled: boolean): IntentMandate {
    this.mustGet(id);
    return this.patchMandate(id, { isEnabled: enabled });
  }

  listMandates(): IntentMandate[] {
    return this.store.list();
  }

  getMandate(id: string): IntentMandate | undefined {
    return this.store.get(id);
  }

  /** What this mandate can actually spend: effectiveRemaining(id), atomic units. */
  remaining(id: string): bigint {
    this.mustGet(id);
    return this.effectiveRemaining(id);
  }

  /**
   * min(limit - spent - pending) over the mandate's chain: a child's own
   * counters can say more than an almost-exhausted ancestor lets it spend.
   */
  effectiveRemaining(id: string): bigint {
    let min: bigint | undefined;
    for (const m of this.chainOf(id)) {
      const r = remainingOf(m);
      if (min === undefined || r < min) min = r;
    }
    return min ?? 0n;
  }

  /**
   * The mandate and its ancestors up to the root (charged mandate first).
   * Bounded: a missing parent or a cycle (a hand-edited store) ends the walk
   * where it is and is logged once; an unknown id yields [].
   */
  chainOf(id: string): IntentMandate[] {
    const chain: IntentMandate[] = [];
    const seen = new Set<string>();
    let cur = this.store.get(id);
    while (cur) {
      chain.push(cur);
      seen.add(cur.id);
      if (cur.parentId === undefined) break;
      const next = this.store.get(cur.parentId);
      if (!next || seen.has(next.id)) {
        if (!this.chainWarned.has(cur.id)) {
          this.chainWarned.add(cur.id);
          this.log(
            `wallet: mandate ${cur.id}: parent ${cur.parentId} ${next ? 'closes a cycle' : 'is missing from the store'}; ` +
              'the chain is cut there (its spend is counted no further up)',
          );
        }
        break;
      }
      cur = next;
    }
    return chain;
  }

  /**
   * Which of the caller's mandates could pay `amount` to `host` ('host' or
   * 'host:port') right now, and why the others cannot. Mandates the caller
   * does not hold are not listed at all.
   */
  eligibleMandates(q: { host: string; amount: bigint; caller?: Caller }): EligibilityResult {
    return this.evaluateAll(this.policyQuery(hostCandidates(q.host), q.amount, this.now()), this.heldBy(q.caller ?? PRINCIPAL));
  }

  /**
   * The ids of signed mandates whose signature does not recover to this
   * wallet's address (a store edited by hand, or moved between keys). The
   * gate never verifies signatures — it is synchronous and viem's recovery
   * is not — so a host runs this once at start-up and disables what it names.
   */
  async verifyMandates(): Promise<string[]> {
    const bad: string[] = [];
    for (const m of this.store.list()) {
      if (m.status !== 'signed' || !m.signature) continue;
      let signer: Address | undefined;
      try {
        signer = await recoverIntentMandateSigner(this.chainId, m, m.signature);
      } catch {
        signer = undefined; // a malformed signature recovers to nobody
      }
      if (signer === undefined || !eqAddr(signer, this.address)) bad.push(m.id);
    }
    return bad;
  }

  /** Releases the lock taken with `lock: true`; a no-op otherwise, and safe to call twice. */
  dispose(): void {
    if (!this.lockPath) return;
    const path = this.lockPath;
    this.lockPath = undefined;
    try {
      if (existsSync(path) && readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
    } catch {
      /* a lock we no longer own is not ours to remove */
    }
  }

  // -------------------------------------------------------------- payments

  /**
   * Plain fetch; on 402 decodes the offer, runs the policy gate (throwing
   * core's PolicyViolation BEFORE any signature exists), reserves the budget,
   * signs a single-use authorization, retries with it attached, reads the
   * settlement the payee reports, records the ledger entry and returns a
   * re-wrapped readable Response (with x-agentpay-nonce / -ledger-status).
   */
  async fetch(url: string, init?: RequestInit, opts: FetchOptions = {}): Promise<Response> {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const cacheKey = `${method} ${u.origin}${u.pathname}`;
    const hosts = urlHostCandidates(u);
    const context = validatePaymentContext(opts.context);
    const caller = opts.caller ?? PRINCIPAL;
    const held = this.heldBy(caller); // throws on a malformed caller before anything is sent

    // ---- 0. host pre-flight: nothing leaves unless a held mandate names the host ----
    if (this.requireMandateHost) this.preflightHost(url, hosts, held, caller, opts.mandateId);

    // ---- 1. Order Mode (402 first) unless a cached offer allows Intent Mode ----
    let required = opts.prepay ? this.offers.get(cacheKey) : undefined;
    if (!required) {
      const first = await this.fetchImpl(url, init);
      if (first.status !== 402) return first;
      const bodyText = await first.text();
      required = this.readPaymentRequired(first, bodyText);
      this.offers.set(cacheKey, required);
    }
    // ---- 2. pick an offer this wallet can honour ----
    const offer = this.chooseOffer(required, url);
    const amount = BigInt(offer.amount);

    // ---- 3 + 4. policy gate and budget reservation: ONE synchronous block ----
    // (no await between them, so parallel calls see each other's reservations)
    const now = this.now();
    const im = this.gateAndReserve({ url, hosts, amount, now, mandateId: opts.mandateId, caller });
    const release = () => this.adjustBudget(im.id, { pending: -amount });

    // ---- 5. sign the single-use authorization (the official client's job) ----
    let payload: PaymentPayload;
    try {
      payload = await this.client.createPaymentPayload({ ...required, accepts: [offer] });
    } catch (err) {
      release(); // nothing left the wallet
      throw err;
    }
    const { authorization, signature } = payload.payload as { authorization: Eip3009Authorization; signature: Hex };
    const nonce = authorization.nonce;
    const validBefore = Number(authorization.validBefore);
    const base = {
      v: LEDGER_VERSION,
      kind: 'payment' as const,
      url,
      host: u.host,
      resource: `${method} ${u.pathname}`,
      network: offer.network,
      asset: offer.asset as Address,
      amount: offer.amount,
      payer: this.address,
      payee: offer.payTo as Address,
      intentMandateId: im.id,
      ...(context !== undefined ? { context } : {}),
      nonce,
      validBefore,
      authorization,
      signature,
    };
    // The ledger line exists from the moment a signature exists: a crash between
    // here and the response leaves an 'in_flight' unknown that reconcile() can
    // settle or expire, instead of a reservation nothing remembers.
    const signedAt = this.now();
    this.ledger.append({ ...base, timestamp: signedAt, signedAt, httpStatus: 0, status: 'unknown', error: 'in_flight' });
    const record = (fields: Pick<LedgerEntry, 'httpStatus' | 'status'> & Partial<Omit<LedgerEntry, 'signedAt'>>): void =>
      this.ledger.updateStatus(nonce, fields.status, { error: undefined, ...fields, timestamp: this.now() });

    // ---- 6. retry with the payment attached ----
    // From here on the signature is out in the world: even a failed request may
    // reach the payee and be settled, so the reservation is NOT released. A
    // transport error re-presents the SAME header (one nonce settles at most
    // once) rather than signing again.
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.http.encodePaymentSignatureHeader(payload))) headers.set(name, value);
    let second: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.transportRetries.attempts; attempt++) {
      try {
        second = await this.fetchImpl(url, { ...init, headers });
        break;
      } catch (err) {
        lastError = err;
        if (attempt === this.transportRetries.attempts || this.now() >= validBefore - REPRESENT_MARGIN_SECONDS) break;
        await sleep(this.transportRetries.delayMs);
      }
    }
    if (!second) {
      record({ httpStatus: 0, status: 'unknown', error: `network: ${(lastError as Error)?.message ?? String(lastError)}` });
      throw lastError;
    }
    const bodyBytes = await second.arrayBuffer();

    // ---- 7. what the payee reported ----
    let settlement: SettleResponse | undefined;
    let settlementError: string | undefined;
    if (second.headers.has('PAYMENT-RESPONSE')) {
      try {
        settlement = this.http.getPaymentSettleResponse((name) => second!.headers.get(name));
      } catch (err) {
        settlementError = `malformed PAYMENT-RESPONSE: ${(err as Error).message}`;
      }
    }
    const delivered = second.status >= 200 && second.status < 300;
    let status: LedgerEntry['status'];
    if (settlement?.success && TX_RE.test(settlement.transaction) && settlement.network === offer.network) {
      // Paid: on every HTTP status. A 5xx after settlement is "paid, not served".
      this.adjustBudget(im.id, { pending: -amount, spent: amount });
      status = 'settled';
      record({
        httpStatus: second.status,
        status,
        transaction: settlement.transaction as Hex,
        ...(delivered ? {} : { error: `paid but http ${second.status}` }),
      });
    } else if (delivered) {
      // Served without a usable settlement report: charged or not is unknown; count it as spent.
      this.adjustBudget(im.id, { pending: -amount, spent: amount });
      status = 'unknown';
      record({
        httpStatus: second.status,
        status,
        error: settlementError ?? (settlement ? `settlement not successful: ${settlement.errorReason ?? '?'}` : 'missing PAYMENT-RESPONSE'),
      });
    } else {
      if (second.status === 402) this.offers.delete(cacheKey); // terms may have changed; renegotiate next time
      if (settlement?.errorReason === 'settlement_pending') {
        // Broadcast, receipt not seen: may well have been charged. Reservation kept until reconcile() knows.
        status = 'unknown';
        record({
          httpStatus: second.status,
          status,
          ...(TX_RE.test(settlement.transaction) ? { transaction: settlement.transaction as Hex } : {}),
          error: 'settlement_pending',
        });
      } else {
        status = 'rejected';
        record({ httpStatus: second.status, status, error: this.refusalReason(second, bodyBytes, settlement) });
      }
    }
    return rewrap(second, bodyBytes, { [NONCE_HEADER]: nonce, [LEDGER_STATUS_HEADER]: status });
  }

  /**
   * Settles the fate of ledger entries against the chain, by chain time: a
   * used nonce means 'settled' (transaction from the AuthorizationUsed log
   * when found); an unused nonce at a block past validBefore means
   * 'expired-unused' (the budget is released; every later block would revert
   * the authorization, so no grace is needed). Rows that already said settled
   * are confirmed once after their validity ended and refunded when the
   * chain never saw the nonce (a payee that lied about settling). Everything
   * stays pending while the RPC is unreachable.
   *
   * This is the one path that mutates rows it did not just write, and it may
   * run beside a live fetch() in the same process. Two rules keep the books
   * straight: an `in_flight` row belongs to its fetch() until chain time is
   * past validBefore (only a crashed fetch leaves one behind that long), and
   * every row is re-read by nonce after the last await before it is booked —
   * a row whose status moved meanwhile was booked by whoever moved it and is
   * only patched with what the chain said (verified, transaction).
   */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { settled: [], expiredUnused: [], stillPending: [], verified: [] };
    const entries = this.ledger
      .read()
      .filter((e) => e.status === 'rejected' || e.status === 'unknown' || (e.status === 'settled' && !e.verified));
    if (entries.length === 0) return result;

    const pc = this.publicClient();
    let block: { number: bigint; timestamp: bigint };
    let rpcChainId: number;
    try {
      [rpcChainId, block] = await Promise.all([pc.getChainId(), pc.getBlock()]);
    } catch {
      result.stillPending.push(...entries.map((e) => e.nonce));
      return result;
    }
    if (rpcChainId !== this.chainId) {
      throw new Error(`MandateWallet: RPC ${this.rpcUrl} serves chain ${rpcChainId} but this wallet is configured for ${this.network}`);
    }
    const chainNow = Number(block.timestamp);

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const amount = BigInt(e.amount);
      const expired = chainNow >= e.validBefore;
      if (e.status === 'settled' && !expired) {
        result.stillPending.push(e.nonce); // confirmed later, when a wrong claim can no longer be settled
        continue;
      }
      if (e.error === 'in_flight' && !expired) {
        result.stillPending.push(e.nonce); // a live fetch() owns it: it will record the payee's answer itself
        continue;
      }
      let used: boolean;
      try {
        used = await pc.readContract({
          address: e.asset,
          abi: EIP3009_ABI,
          functionName: 'authorizationState',
          args: [e.payer, e.nonce],
          blockNumber: block.number,
        });
      } catch (err) {
        if (isTransportError(err)) {
          // RPC unreachable: keep this and every remaining entry as-is.
          for (const rest of entries.slice(i)) result.stillPending.push(rest.nonce);
          break;
        }
        this.ledger.updateStatus(e.nonce, e.status, { error: `reconcile: ${(err as Error).message ?? String(err)}` });
        result.stillPending.push(e.nonce);
        continue;
      }

      const transaction = e.transaction ?? (used && e.status !== 'settled' ? await this.findAuthorizationTx(e, block.number, chainNow) : undefined);

      // The last await is behind us: book against the row as it is NOW.
      const cur = this.rowByNonce(e.nonce) ?? e;
      if (cur.status !== e.status) {
        // A live fetch() finished with this row meanwhile and booked the budget itself.
        if (used && cur.status === 'settled') {
          this.ledger.updateStatus(e.nonce, 'settled', { verified: true, ...(cur.transaction || !transaction ? {} : { transaction }) });
          result.verified.push(e.nonce);
        } else {
          result.stillPending.push(e.nonce); // next run sees the row it became
        }
        continue;
      }

      if (cur.status === 'settled') {
        if (used) {
          this.ledger.updateStatus(e.nonce, 'settled', { verified: true });
          result.verified.push(e.nonce);
        } else {
          this.adjustBudget(cur.intentMandateId, { spent: -amount });
          this.ledger.updateStatus(e.nonce, 'expired-unused', {
            verified: true,
            error: 'PAYMENT-RESPONSE claimed a settlement but the authorization was never used on chain',
          });
          result.expiredUnused.push(e.nonce);
        }
      } else if (used) {
        if (reservationHeld(cur)) this.adjustBudget(cur.intentMandateId, { pending: -amount, spent: amount });
        this.ledger.updateStatus(e.nonce, 'settled', { verified: true, ...(transaction ? { transaction } : {}) });
        result.settled.push(e.nonce);
      } else if (expired) {
        if (reservationHeld(cur)) this.adjustBudget(cur.intentMandateId, { pending: -amount });
        else this.adjustBudget(cur.intentMandateId, { spent: -amount });
        this.ledger.updateStatus(e.nonce, 'expired-unused', { verified: true });
        result.expiredUnused.push(e.nonce);
      } else {
        result.stillPending.push(e.nonce);
      }
    }
    return result;
  }

  report(): SpendReport {
    const totals = { spent: 0n, pending: 0n, settled: 0, rejected: 0, unknown: 0, expiredUnused: 0 };
    const mandates = this.store.list().map((m) => {
      if (m.parentId === undefined) {
        // roots only: a child's spend is already in its root's counters
        totals.spent += BigInt(m.spentAmount);
        totals.pending += BigInt(m.pendingSpentAmount);
      }
      return {
        id: m.id,
        naturalLanguage: m.naturalLanguage,
        limitAmount: m.limitAmount,
        spentAmount: m.spentAmount,
        pendingSpentAmount: m.pendingSpentAmount,
        validUntil: m.validUntil,
        isEnabled: m.isEnabled,
        status: m.status,
        hostAllowlist: [...m.hostAllowlist],
        ...(m.parentId !== undefined ? { parentId: m.parentId } : {}),
        ...(m.holder !== undefined ? { holder: m.holder } : {}),
        remainingAmount: this.effectiveRemaining(m.id).toString(),
      };
    });
    const byHost = new Map<string, bigint>();
    const byResource = new Map<string, bigint>();
    const byChannel = new Map<string, bigint>();
    const bySession = new Map<string, bigint>();
    const add = (map: Map<string, bigint>, key: string, amount: bigint) => map.set(key, (map.get(key) ?? 0n) + amount);
    for (const e of this.ledger.read()) {
      switch (e.status) {
        case 'settled':
          totals.settled++;
          break;
        case 'rejected':
          totals.rejected++;
          break;
        case 'unknown':
          totals.unknown++;
          break;
        case 'expired-unused':
          totals.expiredUnused++;
          break;
      }
      if (isSpendStatus(e.status)) {
        const amount = BigInt(e.amount);
        add(byHost, e.host, amount);
        add(byResource, e.resource, amount);
        add(byChannel, e.context?.channel ?? '', amount);
        add(bySession, e.context?.session ?? '', amount);
      }
    }
    const strings = (map: Map<string, bigint>) => Object.fromEntries([...map].map(([k, v]) => [k, v.toString()]));
    return {
      address: this.address,
      token: this.token,
      network: this.network,
      mandates,
      totals: { ...totals, spent: totals.spent.toString(), pending: totals.pending.toString() },
      byHost: strings(byHost),
      byResource: strings(byResource),
      byChannel: strings(byChannel),
      bySession: strings(bySession),
      policyDenials: this.policyDenials.map((d) => ({ ...d })),
    };
  }

  // ------------------------------------------------------------- internals

  private mustGet(id: string): IntentMandate {
    const m = this.store.get(id);
    if (!m) throw new Error(`no intent mandate ${id}`);
    return m;
  }

  private patchMandate(id: string, patch: Partial<IntentMandate>): IntentMandate {
    const next = { ...this.mustGet(id), ...patch };
    this.store.upsert(next);
    this.store.save();
    return next;
  }

  /**
   * Moves budget between the pending and spent counters (never below zero) on
   * the mandate AND every ancestor — the single chain-aware mutation site, so
   * fetch() and reconcile() cannot disagree on what a child's payment moves —
   * and persists once.
   */
  private adjustBudget(id: string, delta: { pending?: bigint; spent?: bigint }): void {
    const chain = this.chainOf(id);
    if (chain.length === 0) return; // mandate file was replaced under us; nothing to book against
    const clamp = (v: bigint) => (v < 0n ? 0n : v);
    for (const m of chain) {
      this.store.upsert({
        ...m,
        pendingSpentAmount: clamp(BigInt(m.pendingSpentAmount) + (delta.pending ?? 0n)).toString(),
        spentAmount: clamp(BigInt(m.spentAmount) + (delta.spent ?? 0n)).toString(),
      });
    }
    this.store.save();
  }

  /**
   * The counters in mandates.json are a cache of the ledger: on load they are
   * recomputed from it (pending = reservations still held, spent = committed
   * payments) so the two crash windows of fetch() heal themselves — a
   * reservation saved before its ledger line existed, or a spend saved before
   * the line left in_flight. Each row is applied to the charged mandate's
   * whole chain, exactly as adjustBudget booked it. Ledger lines for mandates
   * the store no longer has are ignored; a drift is logged and saved once.
   */
  private rebuildBudgets(): void {
    const pending = new Map<string, bigint>();
    const spent = new Map<string, bigint>();
    for (const e of this.ledger.read()) {
      const amount = BigInt(e.amount);
      for (const m of this.chainOf(e.intentMandateId)) {
        if (reservationHeld(e)) pending.set(m.id, (pending.get(m.id) ?? 0n) + amount);
        else if (isSpendStatus(e.status)) spent.set(m.id, (spent.get(m.id) ?? 0n) + amount);
      }
    }
    let dirty = false;
    for (const m of this.store.list()) {
      const pendingSpentAmount = (pending.get(m.id) ?? 0n).toString();
      const spentAmount = (spent.get(m.id) ?? 0n).toString();
      if (m.pendingSpentAmount === pendingSpentAmount && m.spentAmount === spentAmount) continue;
      this.log(
        `wallet: mandate ${m.id}: counters rebuilt from the ledger ` +
          `(spent ${m.spentAmount} -> ${spentAmount}, pending ${m.pendingSpentAmount} -> ${pendingSpentAmount})`,
      );
      this.store.upsert({ ...m, pendingSpentAmount, spentAmount });
      dirty = true;
    }
    if (dirty) this.store.save();
  }

  private policyQuery(hosts: readonly string[], amount: bigint, now: number): PolicyQuery {
    return {
      hosts,
      amount,
      now,
      attemptsInWindow: (id) => pruneWindow(this.mandateAttempts.get(id) ?? [], now).length,
    };
  }

  /** The mandates in the caller's holder set (holderSetFor), in store order. */
  private heldBy(caller: Caller): IntentMandate[] {
    const set = holderSetFor(caller);
    return this.store.list().filter((m) => set.has(m.holder ?? ''));
  }

  /** Policy over the caller's mandates only (each with its chain); mandates outside the set are invisible. */
  private evaluateAll(q: PolicyQuery, held: readonly IntentMandate[]): EligibilityResult {
    const eligible: IntentMandate[] = [];
    const rejected: EligibilityResult['rejected'] = [];
    for (const m of held) {
      const r = chainRejection(this.chainOf(m.id), q);
      if (r) rejected.push({ id: m.id, reason: r.reason, detail: r.detail });
      else eligible.push(m);
    }
    eligible.sort((a, b) => a.validUntil - b.validUntil || a.createdAt - b.createdAt);
    return { eligible, rejected };
  }

  /**
   * The refusal for an empty holder set: `mandate_required` for a principal
   * whose store is empty (nothing exists yet; the hint says to request one),
   * `no_held_mandate` otherwise (budgets exist, none is this caller's).
   */
  private denyUnheld(caller: Caller, host: string, amount: bigint, url: string): never {
    if (caller.kind === 'principal' && this.store.list().length === 0) {
      this.deny('mandate_required', { host, amount: amount.toString() }, url);
    }
    this.deny('no_held_mandate', { caller: callerLabel(caller), host, amount: amount.toString() }, url);
  }

  /**
   * requireMandateHost: refuses before the first request unless a mandate the
   * caller holds (the explicit one, when given) names the URL's host. Only
   * the allowlist is consulted here — the gate applies the rest once the
   * price is known.
   */
  private preflightHost(url: string, hosts: string[], held: readonly IntentMandate[], caller: Caller, mandateId?: string): void {
    const host = hosts[hosts.length - 1];
    let candidates = held;
    if (mandateId !== undefined) {
      const m = this.store.get(mandateId);
      if (!m) this.deny('mandate_not_found', { mandateId }, url, mandateId);
      if (!held.some((h) => h.id === m.id)) {
        this.deny('holder_mismatch', { mandateId, holder: m.holder, caller: callerLabel(caller) }, url, mandateId);
      }
      candidates = [m];
    } else if (held.length === 0) {
      this.denyUnheld(caller, host, 0n, url);
    }
    if (!candidates.some((m) => hostAllowed(m.hostAllowlist, hosts))) {
      this.deny('host_not_allowed', { host, mandateIds: candidates.map((m) => m.id), ...(mandateId !== undefined ? { mandateId } : {}) }, url, mandateId);
    }
  }

  private rowByNonce(nonce: Hex): LedgerEntry | undefined {
    return this.ledger.read().find((e) => e.nonce.toLowerCase() === nonce.toLowerCase());
  }

  private takeLock(dir: string): string {
    const holder = lockedBy(dir);
    if (holder !== undefined) {
      // Our own pid included: a second wallet in this process is two in-memory copies of one store just the same.
      throw new Error(`wallet home ${dir} is locked by pid ${holder} (${join(dir, LOCK_FILE)}): one wallet process per home`);
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, `${process.pid}\n`, 'utf8');
    return path;
  }

  private deny(reason: PolicyReason, detail: Record<string, unknown>, url: string, mandateId?: string): never {
    this.policyDenials.push({
      reason,
      url,
      ...(mandateId !== undefined ? { mandateId } : {}),
      timestamp: this.now(),
    });
    throw new PolicyViolation(reason, detail, paymentModelContext(reason, detail));
  }

  /** The PAYMENT-REQUIRED header of a 402 (V2 carries everything there); the body is ignored. */
  private readPaymentRequired(res: Response, bodyText: string): PaymentRequired {
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = undefined;
    }
    try {
      return this.http.getPaymentRequiredResponse((name) => res.headers.get(name), body);
    } catch (err) {
      throw new WireError(`402 without a usable PAYMENT-REQUIRED header: ${(err as Error).message}`);
    }
  }

  /** First offer we can honour: exact on our network and token, under the token domain we know, with a bounded validity. */
  private chooseOffer(required: PaymentRequired, url: string): PaymentRequirements {
    const accepts = Array.isArray(required.accepts) ? required.accepts : [];
    const candidates = accepts.filter((o) => this.isSupportedOffer(o));
    if (candidates.length === 0) {
      this.deny('unsupported_offer', { network: this.network, asset: this.token, assetDomain: this.assetDomain, offered: accepts.length }, url);
    }
    const cap = this.caps.maxAuthorizationValiditySeconds;
    const bounded = candidates.find((o) => o.maxTimeoutSeconds <= cap);
    if (!bounded) {
      this.deny('timeout_too_long', { maxTimeoutSeconds: candidates[0].maxTimeoutSeconds, cap }, url);
    }
    return bounded;
  }

  private isSupportedOffer(o: unknown): o is PaymentRequirements {
    return isPayableOffer(o, { network: this.network, token: this.token, assetDomain: this.assetDomain });
  }

  /**
   * Policy gate (every denial throws before anything is signed) followed by
   * the reservation, with no await in between. The caller's holder set is
   * resolved here, inside the synchronous block, so a delegation or disable
   * that landed while the offer was being fetched counts. Every member of
   * the chosen mandate's chain passed its full policy, is reserved on and
   * gets the attempt in its rate window. Returns the charged mandate.
   */
  private gateAndReserve(p: {
    url: string;
    hosts: string[];
    amount: bigint;
    now: number;
    mandateId?: string;
    caller: Caller;
  }): IntentMandate {
    const { url, hosts, amount, now, caller } = p;
    if (this.caps.perCallMaxAtomic !== undefined && amount > this.caps.perCallMaxAtomic) {
      this.deny('per_call_max', { amount: amount.toString(), perCallMax: this.caps.perCallMaxAtomic.toString() }, url);
    }
    if (this.caps.maxCallsPerMinute !== undefined) {
      this.attempts = pruneWindow(this.attempts, now);
      if (this.attempts.length >= this.caps.maxCallsPerMinute) {
        this.deny(
          'rate_limited',
          { maxCallsPerMinute: this.caps.maxCallsPerMinute, attemptsInWindow: this.attempts.length },
          url,
        );
      }
    }
    const q = this.policyQuery(hosts, amount, now);
    const held = this.heldBy(caller);
    let chosen: IntentMandate;
    if (p.mandateId !== undefined) {
      const m = this.store.get(p.mandateId);
      if (!m) this.deny('mandate_not_found', { mandateId: p.mandateId }, url, p.mandateId);
      if (!held.some((h) => h.id === m.id)) {
        this.deny('holder_mismatch', { mandateId: m.id, holder: m.holder, caller: callerLabel(caller) }, url, m.id);
      }
      const r: Rejection | undefined = chainRejection(this.chainOf(m.id), q);
      if (r) this.deny(r.reason, r.detail, url, m.id);
      chosen = m;
    } else {
      if (held.length === 0) this.denyUnheld(caller, hosts[hosts.length - 1], amount, url);
      const { eligible, rejected } = this.evaluateAll(q, held);
      if (eligible.length === 0) {
        const hasSigned = held.some((m) => m.status === 'signed');
        const r = pickRejection(rejected, hasSigned, { host: hosts[hosts.length - 1], amount: amount.toString() });
        this.deny(r.reason, r.detail, url, typeof r.detail.mandateId === 'string' ? r.detail.mandateId : undefined);
      }
      chosen = eligible[0];
    }

    // ---- reservation (synchronous with the gate above) ----
    this.attempts.push(now);
    for (const m of this.chainOf(chosen.id)) {
      const per = this.mandateAttempts.get(m.id) ?? [];
      per.push(now);
      this.mandateAttempts.set(m.id, pruneWindow(per, now));
    }
    this.adjustBudget(chosen.id, { pending: amount }); // the whole chain; persists via store.save()
    return this.mustGet(chosen.id);
  }

  /** The reason code of a refusal: the PAYMENT-REQUIRED header's error, else the settlement's, else the JSON body's, else the status. */
  private refusalReason(res: Response, bodyBytes: ArrayBuffer, settlement: SettleResponse | undefined): string {
    const header = res.headers.get('PAYMENT-REQUIRED');
    if (header) {
      try {
        const error = this.http.getPaymentRequiredResponse((name) => res.headers.get(name)).error;
        if (error) return error;
      } catch {
        /* fall through */
      }
    }
    if (settlement && !settlement.success && settlement.errorReason) return settlement.errorReason;
    return errorOfBody(bodyBytes) ?? `http ${res.status}`;
  }

  /** Best effort: the AuthorizationUsed log for this nonce, scanned back from `latest` to around the signing time. */
  private async findAuthorizationTx(e: LedgerEntry, latest: bigint, chainNow: number): Promise<Hex | undefined> {
    const blockTime = BLOCK_TIME_SECONDS[e.network];
    let fromBlock = 0n;
    if (blockTime && e.signedAt !== undefined) {
      const lookback = BigInt(Math.ceil(Math.max(0, chainNow - e.signedAt) / blockTime) + LOG_LOOKBACK_SLACK_BLOCKS);
      fromBlock = latest > lookback ? latest - lookback : 0n;
    }
    try {
      const logs = await this.publicClient().getContractEvents({
        address: e.asset,
        abi: EIP3009_ABI,
        eventName: 'AuthorizationUsed',
        args: { authorizer: e.payer, nonce: e.nonce },
        fromBlock,
        toBlock: latest,
        strict: true,
      });
      return logs[0]?.transactionHash ?? undefined;
    } catch {
      return undefined;
    }
  }
}

/** 'principal', 'child of <parentSession>', 'session <id>', 'bot <id>': the caller as a refusal names it. */
function callerLabel(c: Caller): string {
  switch (c.kind) {
    case 'principal':
      return 'principal';
    case 'child':
      return `child${c.id ? ` ${c.id}` : ''}${c.parentSession ? ` of ${c.parentSession}` : ''}`;
    default:
      return `${c.kind}${c.id ? ` ${c.id}` : ''}`;
  }
}

/** Whether the mandate's budget is still in `pendingSpentAmount` (vs. already moved to spent). */
function reservationHeld(e: LedgerEntry): boolean {
  if (e.status === 'rejected') return true;
  // 'unknown' from a request that errored after signing keeps the reservation;
  // 'unknown' after a 2xx delivery was already converted to spend.
  return e.status === 'unknown' && !(e.httpStatus >= 200 && e.httpStatus < 300);
}

function isTransportError(err: unknown): boolean {
  if (err instanceof BaseError) return err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function errorOfBody(bytes: ArrayBuffer): string | undefined {
  const text = Buffer.from(bytes).toString('utf8');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

/** A readable Response over bytes already consumed (same status/headers, plus ours). */
function rewrap(res: Response, body: ArrayBuffer, extra: Record<string, string>): Response {
  const canHaveBody = res.status !== 204 && res.status !== 205 && res.status !== 304;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(canHaveBody ? body : null, { status: res.status, statusText: res.statusText, headers });
}
