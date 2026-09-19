import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  defineChain,
  http,
  isAddress,
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
  X402_SCHEME,
  chainIdFromNetwork,
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
import { hostCandidates, urlHostCandidates } from './hosts.js';
import { LEDGER_VERSION, Ledger, type LedgerEntry } from './ledger.js';
import {
  IntentMandateStore,
  buildIntentMandate,
  signIntentMandate,
  type IntentMandate,
  type IntentMandateInput,
} from './mandate-store.js';
import {
  mandateRejection,
  pickRejection,
  pruneWindow,
  remainingOf,
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
}

export interface FetchOptions {
  /** Charge this intent mandate instead of auto-selecting one. */
  mandateId?: string;
  /** Intent Mode: when an offer for this resource is cached, attach the payment to the first request. */
  prepay?: boolean;
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
    > & { remainingAmount: string }
  >;
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

const DEFAULT_MAX_AUTHORIZATION_VALIDITY = 300;
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

  /** Cached 402 offers keyed by 'METHOD origin/path' (Intent Mode source). */
  private readonly offers = new Map<string, PaymentRequired>();
  /** Unix-second timestamps of gate-passing attempts (wallet-wide rate limit). */
  private attempts: number[] = [];
  /** Same, per intent mandate. */
  private readonly mandateAttempts = new Map<string, number[]>();
  private readonly policyDenials: PolicyDenial[] = [];

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
    this.store = new IntentMandateStore(opts.mandatesPath);
    this.ledger = new Ledger(opts.ledgerPath, this.log);
    this.rebuildBudgets();
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

  /** Creates a draft (nothing can be spent against it until approveIntentMandate). */
  async createIntentMandate(input: IntentMandateInput, opts: { approve?: boolean } = {}): Promise<IntentMandate> {
    const draft = buildIntentMandate(input, { chainId: this.chainId, now: this.now() });
    this.store.upsert(draft);
    this.store.save();
    return opts.approve ? this.approveIntentMandate(draft.id) : draft;
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

  /** limit - spent - pending, atomic units. */
  remaining(id: string): bigint {
    return remainingOf(this.mustGet(id));
  }

  /** Which mandates could pay `amount` to `host` ('host' or 'host:port') right now, and why the others cannot. */
  eligibleMandates(q: { host: string; amount: bigint }): EligibilityResult {
    return this.evaluateAll(this.policyQuery(hostCandidates(q.host), q.amount, this.now()));
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
    const im = this.gateAndReserve({ url, hosts: urlHostCandidates(u), amount, now, mandateId: opts.mandateId });
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

      if (e.status === 'settled') {
        if (used) {
          this.ledger.updateStatus(e.nonce, 'settled', { verified: true });
          result.verified.push(e.nonce);
        } else {
          this.adjustBudget(e.intentMandateId, { spent: -amount });
          this.ledger.updateStatus(e.nonce, 'expired-unused', {
            verified: true,
            error: 'PAYMENT-RESPONSE claimed a settlement but the authorization was never used on chain',
          });
          result.expiredUnused.push(e.nonce);
        }
      } else if (used) {
        const transaction = e.transaction ?? (await this.findAuthorizationTx(e, block.number, chainNow));
        if (reservationHeld(e)) this.adjustBudget(e.intentMandateId, { pending: -amount, spent: amount });
        this.ledger.updateStatus(e.nonce, 'settled', { verified: true, ...(transaction ? { transaction } : {}) });
        result.settled.push(e.nonce);
      } else if (expired) {
        if (reservationHeld(e)) this.adjustBudget(e.intentMandateId, { pending: -amount });
        else this.adjustBudget(e.intentMandateId, { spent: -amount });
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
      totals.spent += BigInt(m.spentAmount);
      totals.pending += BigInt(m.pendingSpentAmount);
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
        remainingAmount: remainingOf(m).toString(),
      };
    });
    const byHost = new Map<string, bigint>();
    const byResource = new Map<string, bigint>();
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
        byHost.set(e.host, (byHost.get(e.host) ?? 0n) + amount);
        byResource.set(e.resource, (byResource.get(e.resource) ?? 0n) + amount);
      }
    }
    return {
      address: this.address,
      token: this.token,
      network: this.network,
      mandates,
      totals: { ...totals, spent: totals.spent.toString(), pending: totals.pending.toString() },
      byHost: Object.fromEntries([...byHost].map(([k, v]) => [k, v.toString()])),
      byResource: Object.fromEntries([...byResource].map(([k, v]) => [k, v.toString()])),
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

  /** Moves budget between the pending and spent counters (never below zero) and persists. */
  private adjustBudget(id: string, delta: { pending?: bigint; spent?: bigint }): void {
    const m = this.store.get(id);
    if (!m) return; // mandate file was replaced under us; nothing to book against
    const clamp = (v: bigint) => (v < 0n ? 0n : v);
    this.patchMandate(id, {
      pendingSpentAmount: clamp(BigInt(m.pendingSpentAmount) + (delta.pending ?? 0n)).toString(),
      spentAmount: clamp(BigInt(m.spentAmount) + (delta.spent ?? 0n)).toString(),
    });
  }

  /**
   * The counters in mandates.json are a cache of the ledger: on load they are
   * recomputed from it (pending = reservations still held, spent = committed
   * payments) so the two crash windows of fetch() heal themselves — a
   * reservation saved before its ledger line existed, or a spend saved before
   * the line left in_flight. Ledger lines for mandates the store no longer has
   * are ignored; a drift is logged and saved once.
   */
  private rebuildBudgets(): void {
    const pending = new Map<string, bigint>();
    const spent = new Map<string, bigint>();
    for (const e of this.ledger.read()) {
      const amount = BigInt(e.amount);
      if (reservationHeld(e)) pending.set(e.intentMandateId, (pending.get(e.intentMandateId) ?? 0n) + amount);
      else if (isSpendStatus(e.status)) spent.set(e.intentMandateId, (spent.get(e.intentMandateId) ?? 0n) + amount);
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

  private evaluateAll(q: PolicyQuery): EligibilityResult {
    const eligible: IntentMandate[] = [];
    const rejected: EligibilityResult['rejected'] = [];
    for (const m of this.store.list()) {
      const r = mandateRejection(m, q);
      if (r) rejected.push({ id: m.id, reason: r.reason, detail: r.detail });
      else eligible.push(m);
    }
    eligible.sort((a, b) => a.validUntil - b.validUntil || a.createdAt - b.createdAt);
    return { eligible, rejected };
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
    if (typeof o !== 'object' || o === null) return false;
    const x = o as Partial<PaymentRequirements>;
    const extra = (x.extra ?? undefined) as Record<string, unknown> | undefined;
    return (
      x.scheme === X402_SCHEME &&
      x.network === this.network &&
      typeof x.asset === 'string' &&
      eqAddr(x.asset, this.token) &&
      typeof x.amount === 'string' &&
      /^\d+$/.test(x.amount) &&
      BigInt(x.amount) > 0n &&
      typeof x.payTo === 'string' &&
      isAddress(x.payTo, { strict: false }) &&
      typeof x.maxTimeoutSeconds === 'number' &&
      Number.isInteger(x.maxTimeoutSeconds) &&
      x.maxTimeoutSeconds > 0 &&
      typeof extra === 'object' &&
      extra !== null &&
      extra.name === this.assetDomain.name &&
      extra.version === this.assetDomain.version &&
      (extra.assetTransferMethod === undefined || extra.assetTransferMethod === 'eip3009')
    );
  }

  /**
   * Policy gate (every denial throws before anything is signed) followed by
   * the reservation, with no await in between. Returns the charged mandate.
   */
  private gateAndReserve(p: {
    url: string;
    hosts: string[];
    amount: bigint;
    now: number;
    mandateId?: string;
  }): IntentMandate {
    const { url, hosts, amount, now } = p;
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
    let chosen: IntentMandate;
    if (p.mandateId !== undefined) {
      const m = this.store.get(p.mandateId);
      if (!m) this.deny('mandate_not_found', { mandateId: p.mandateId }, url, p.mandateId);
      const r: Rejection | undefined = mandateRejection(m, q);
      if (r) this.deny(r.reason, r.detail, url, m.id);
      chosen = m;
    } else {
      const { eligible, rejected } = this.evaluateAll(q);
      if (eligible.length === 0) {
        const hasSigned = this.store.list().some((m) => m.status === 'signed');
        const r = pickRejection(rejected, hasSigned, { host: hosts[hosts.length - 1], amount: amount.toString() });
        this.deny(r.reason, r.detail, url, typeof r.detail.mandateId === 'string' ? r.detail.mandateId : undefined);
      }
      chosen = eligible[0];
    }

    // ---- reservation (synchronous with the gate above) ----
    this.attempts.push(now);
    const per = this.mandateAttempts.get(chosen.id) ?? [];
    per.push(now);
    this.mandateAttempts.set(chosen.id, pruneWindow(per, now));
    this.adjustBudget(chosen.id, { pending: amount }); // persists via store.save()
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
