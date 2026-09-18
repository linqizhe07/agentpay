import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { AEP2_DEBIT_WALLET_ABI, MOCK_USDC_ABI } from '@agentpay/contracts';
import {
  HEADER,
  PolicyViolation,
  chainIdFromNetwork,
  encodeHeader,
  mandateDigest,
  paymentModelContext,
  randomNonce,
  readPaymentRequired,
  readPaymentResponse,
  resourceRef,
  signMandate,
  verifySpReceipt,
  type Address,
  type Hex,
  type Mandate,
  type MandateDomain,
  type MandatePayload,
  type PaymentPayload,
  type PaymentRequirements,
  type PolicyReason,
  type SettlementInfo,
  type SpReceipt,
} from '@agentpay/core';
import { hostCandidates, urlHostCandidates } from './hosts.js';
import { Ledger, type LedgerEntry } from './ledger.js';
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
  /** Upper bound on a signed mandate's deadline horizon. Default 86400 (24h). */
  maxMandateValiditySeconds?: number;
  /** When false, a MISSING SP receipt still yields ledger status 'enqueued'. Default true. */
  requireReceipt?: boolean;
  /** Send FluxA's legacy X-Payment-Mandate header instead of the x402 PAYMENT-SIGNATURE envelope. */
  legacyHeader?: boolean;
}

export interface MandateWalletOptions {
  /** Payer EOA private key (or pass `account`). */
  key?: Hex;
  account?: PrivateKeyAccount;
  rpcUrl: string;
  /** AEP2DebitWallet contract this wallet pays from. */
  walletContract: Address;
  /** The ERC-20 this wallet pays with (USDC). */
  token: Address;
  /** CAIP-2 network, e.g. 'eip155:31337'. */
  network: string;
  /** When set (non-empty), offers naming any other settlement processor are refused. */
  trustedSps?: Address[];
  /** mandates.json; omitted = in-memory store. */
  mandatesPath?: string;
  /** ledger.jsonl (append-only). */
  ledgerPath: string;
  caps?: MandateWalletCaps;
  /** Injectable clock (unix seconds). */
  now?: () => number;
  /** Injectable fetch. */
  fetch?: typeof fetch;
  /** Receives one line per repair the wallet makes to its files on load (counters rebuilt, torn ledger tail dropped). Default: discard. */
  log?: (line: string) => void;
}

export interface FetchOptions {
  /** Charge this intent mandate instead of auto-selecting one. */
  mandateId?: string;
  /** Intent Mode: when an offer for this resource is cached, attach the mandate to the first request. */
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
  walletContract: Address;
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
    /** Atomic units committed (enqueued/settled), decimal string. */
    spent: string;
    /** Atomic units reserved for signed mandates of unknown fate, decimal string. */
    pending: string;
    enqueued: number;
    settled: number;
    rejected: number;
    unknown: number;
    expiredUnused: number;
    /** Mandates the SP receipted but never settled before the deadline (not counting those the payer pre-empted by revoking the SP). */
    spDefaults: number;
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

const DEFAULT_MAX_MANDATE_VALIDITY = 86_400;
/** SP statuses meaning "your mandate is in the queue (or already settled)". */
const SP_ENQUEUED_STATUSES = new Set(['pending', 'settling', 'settled']);
const SP_DEFAULT_MARK = 'sp_default';
/** An enqueued mandate that expired because the payer's revocation of the SP landed inside the receipt's window. */
const PAYER_REVOKED_MARK = 'payer_revoked';

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isSpendStatus = (s: LedgerEntry['status']): boolean =>
  s === 'enqueued' || s === 'settled' || s === 'unknown';

/**
 * Payer-side AEP2 wallet: a fetch wrapper that answers 402 offers by signing a
 * one-time Mandate under an approved intent mandate's budget, verifies the
 * settlement processor's receipt, keeps a JSONL ledger, and manages the
 * payer's AEP2DebitWallet balance on-chain.
 *
 * Invariant: no signature is produced unless the policy gate passed and the
 * budget was reserved — in one synchronous step, so concurrent fetch() calls
 * cannot overshoot a limit.
 */
export class MandateWallet {
  readonly address: Address;
  readonly walletContract: Address;
  readonly token: Address;
  readonly network: string;
  readonly chainId: number;

  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
  private readonly trustedSps?: Address[];
  private readonly store: IntentMandateStore;
  private readonly ledger: Ledger;
  private readonly caps: Required<Pick<MandateWalletCaps, 'maxMandateValiditySeconds' | 'requireReceipt'>> &
    MandateWalletCaps;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  /** Cached 402 offers keyed by 'METHOD origin/path' (Intent Mode source). */
  private readonly offers = new Map<string, PaymentRequirements>();
  /** Unix-second timestamps of gate-passing attempts (wallet-wide rate limit). */
  private attempts: number[] = [];
  /** Same, per intent mandate. */
  private readonly mandateAttempts = new Map<string, number[]>();
  private readonly policyDenials: PolicyDenial[] = [];

  constructor(opts: MandateWalletOptions) {
    if (opts.account) this.account = opts.account;
    else if (opts.key) this.account = privateKeyToAccount(opts.key);
    else throw new TypeError('MandateWallet needs `key` or `account`');
    this.address = this.account.address;
    this.walletContract = opts.walletContract;
    this.token = opts.token;
    this.network = opts.network;
    this.chainId = chainIdFromNetwork(opts.network);
    this.trustedSps = opts.trustedSps && opts.trustedSps.length > 0 ? opts.trustedSps : undefined;
    this.log = opts.log ?? (() => {});
    this.store = new IntentMandateStore(opts.mandatesPath);
    this.ledger = new Ledger(opts.ledgerPath, this.log);
    this.rebuildBudgets();
    this.caps = {
      ...opts.caps,
      maxMandateValiditySeconds: opts.caps?.maxMandateValiditySeconds ?? DEFAULT_MAX_MANDATE_VALIDITY,
      requireReceipt: opts.caps?.requireReceipt ?? true,
    };
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    const f = opts.fetch;
    this.fetchImpl = f ? (input, init) => f(input, init) : (input, init) => globalThis.fetch(input, init);

    // A concrete chain makes viem sign with the configured chainId and reject
    // an RPC that serves a different chain (ChainMismatchError) before any tx.
    const chain = defineChain({
      id: this.chainId,
      name: opts.network,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    });
    // No transport retries: hardhat reports deterministic reverts with a
    // retryable-looking code, and reconcile() must fail fast when the RPC is down.
    const transport = http(opts.rpcUrl, { retryCount: 0 });
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
    this.walletClient = createWalletClient({ account: this.account, chain, transport, pollingInterval: 250 });
  }

  // ------------------------------------------------------------------ chain

  /** ERC-20 approve + AEP2DebitWallet.deposit; both mined before returning. */
  async deposit(amount: bigint): Promise<{ approveTx: Hex; depositTx: Hex }> {
    const approveTx = await this.walletClient.writeContract({
      address: this.token,
      abi: MOCK_USDC_ABI,
      functionName: 'approve',
      args: [this.walletContract, amount],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
    const depositTx = await this.walletClient.writeContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'deposit',
      args: [this.token, amount],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: depositTx });
    return { approveTx, depositTx };
  }

  /** Total custody in the debit wallet (includes funds parked in a pending withdrawal). */
  balance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'balances',
      args: [this.address, this.token],
    });
  }

  /** What settlement processors may admit NEW mandates against. */
  debitable(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'debitableBalance',
      args: [this.address, this.token],
    });
  }

  /** Lets `sp` settle this payer's mandates; also clears a scheduled revocation. */
  async authorizeSP(sp: Address): Promise<Hex> {
    return this.walletTx('authorizeSP', [sp]);
  }

  /**
   * Schedules the revocation: `sp` keeps settling for the contract's
   * withdrawDelay (see `authorizationOf().revokeAt`), so mandates it already
   * receipted are honoured. Reverts (BadParams) when `sp` is not authorized.
   */
  async revokeSP(sp: Address): Promise<Hex> {
    return this.walletTx('revokeSP', [sp]);
  }

  /** Cancels a revocation that has not taken effect yet (BadParams otherwise). */
  async cancelRevokeSP(sp: Address): Promise<Hex> {
    return this.walletTx('cancelRevoke', [sp]);
  }

  /** The contract's verdict right now: enabled and no revocation in effect. */
  isSpAuthorized(sp: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'authorizedSP',
      args: [this.address, sp],
    });
  }

  /** `revokeAt` is 0 or the unix second at which `sp` loses the right to settle. */
  async authorizationOf(sp: Address): Promise<{ enabled: boolean; revokeAt: number }> {
    const [enabled, revokeAt] = await this.publicClient.readContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'authorizationOf',
      args: [this.address, sp],
    });
    return { enabled, revokeAt: Number(revokeAt) };
  }

  async requestWithdraw(amount: bigint): Promise<Hex> {
    return this.walletTx('requestWithdraw', [this.token, amount]);
  }

  async cancelWithdraw(): Promise<Hex> {
    return this.walletTx('cancelWithdraw', [this.token]);
  }

  async executeWithdraw(to: Address = this.address): Promise<Hex> {
    return this.walletTx('executeWithdraw', [this.token, to]);
  }

  async pendingWithdrawal(): Promise<{ amount: bigint; unlockAt: number }> {
    const [amount, unlockAt] = await this.publicClient.readContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'withdrawals',
      args: [this.address, this.token],
    });
    return { amount, unlockAt: Number(unlockAt) };
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
   * signs a one-time Mandate, retries with it attached, verifies the SP receipt,
   * records the ledger entry and returns a re-wrapped readable Response.
   */
  async fetch(url: string, init?: RequestInit, opts: FetchOptions = {}): Promise<Response> {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const cacheKey = `${method} ${u.origin}${u.pathname}`;

    // ---- 1. Order Mode (402 first) unless a cached offer allows Intent Mode ----
    let offer = opts.prepay ? this.offers.get(cacheKey) : undefined;
    if (!offer) {
      const first = await this.fetchImpl(url, init);
      if (first.status !== 402) return first;
      const bodyText = await first.text();
      const required = readPaymentRequired(first.headers, bodyText);
      // ---- 2. pick an offer this wallet can honour ----
      offer = this.chooseOffer(Array.isArray(required.accepts) ? required.accepts : [], url);
      this.offers.set(cacheKey, offer);
    }
    const extra = offer.extra;
    const amount = BigInt(offer.amount);

    // ---- 3 + 4. policy gate and budget reservation: ONE synchronous block ----
    // (no await between them, so parallel calls see each other's reservations)
    const now = this.now();
    const im = this.gateAndReserve({ url, hosts: urlHostCandidates(u), amount, now, mandateId: opts.mandateId });
    const release = () => this.adjustBudget(im.id, { pending: -amount });

    // ---- 5. build + sign the one-time mandate ----
    const horizon = Math.min(
      extra.settleWindowSeconds + Math.max(offer.maxTimeoutSeconds || 0, 60),
      this.caps.maxMandateValiditySeconds,
    );
    const mandate: Mandate = {
      owner: this.address,
      token: offer.asset,
      payee: offer.payTo,
      amount: offer.amount,
      nonce: randomNonce(),
      deadline: now + horizon,
      ref: resourceRef(offer.resource, extra.quoteId),
    };
    const domain: MandateDomain = { chainId: this.chainId, verifyingContract: extra.wallet };
    let payerSig: Hex;
    try {
      payerSig = await signMandate(this.account, domain, mandate);
    } catch (err) {
      release(); // nothing left the wallet
      throw err;
    }
    const digest = mandateDigest(domain, mandate);
    const base = {
      kind: 'payment' as const,
      url,
      host: u.host,
      resource: offer.resource,
      network: offer.network,
      asset: offer.asset,
      amount: offer.amount,
      payer: this.address,
      payee: offer.payTo,
      walletContract: extra.wallet,
      intentMandateId: im.id,
      mandate,
      payerSig,
      mandateDigest: digest,
    };
    // The ledger line exists from the moment a signature exists: a crash between
    // here and the response leaves an 'in_flight' unknown that reconcile() can
    // settle or expire, instead of a reservation nothing remembers.
    const signedAt = this.now();
    this.ledger.append({ ...base, timestamp: signedAt, signedAt, httpStatus: 0, status: 'unknown', error: 'in_flight' });
    const record = (fields: Pick<LedgerEntry, 'httpStatus' | 'status'> & Partial<Omit<LedgerEntry, 'signedAt'>>): void =>
      this.ledger.updateStatus(digest, fields.status, { error: undefined, spReceipt: undefined, ...fields, timestamp: this.now() });

    // ---- 6. retry with the mandate attached ----
    // From here on the signature is out in the world: even a failed request may
    // reach the payee and be enqueued, so the reservation is NOT released.
    const payload: MandatePayload = { mandate, payerSig };
    const headers = new Headers(init?.headers);
    if (this.caps.legacyHeader) {
      headers.set(HEADER.legacyMandate, encodeHeader(payload));
    } else {
      const envelope: PaymentPayload = { x402Version: 2, accepted: offer, payload };
      headers.set(HEADER.signature, encodeHeader(envelope));
    }
    let second: Response;
    try {
      second = await this.fetchImpl(url, { ...init, headers });
    } catch (err) {
      record({ httpStatus: 0, status: 'unknown', error: `network: ${(err as Error).message ?? String(err)}` });
      throw err;
    }
    const bodyBytes = await second.arrayBuffer();

    // ---- 7. refused ----
    if (second.status < 200 || second.status >= 300) {
      if (second.status === 402) this.offers.delete(cacheKey); // terms may have changed; renegotiate next time
      const error = errorOfBody(bodyBytes) ?? `http ${second.status}`;
      if (second.status === 409) {
        // 'replay': the payee saw this digest before. Ask the SP whether it is queued.
        const spStatus = await this.querySpStatus(extra.sp, digest);
        if (spStatus !== undefined && SP_ENQUEUED_STATUSES.has(spStatus)) {
          this.adjustBudget(im.id, { pending: -amount, spent: amount });
          record({ httpStatus: second.status, status: 'enqueued', error: `${error}; sp status ${spStatus}` });
          return rewrap(second, bodyBytes);
        }
      }
      record({ httpStatus: second.status, status: 'rejected', error });
      return rewrap(second, bodyBytes);
    }

    // ---- 8. delivered: verify the SP receipt, commit the spend ----
    let info: SettlementInfo | undefined;
    let error: string | undefined;
    try {
      info = readPaymentResponse(second.headers);
    } catch (err) {
      error = `malformed PAYMENT-RESPONSE: ${(err as Error).message}`;
    }
    const receipt: SpReceipt | undefined = info?.spReceipt;
    let status: LedgerEntry['status'];
    if (error !== undefined) {
      status = 'unknown';
    } else if (receipt === undefined) {
      status = this.caps.requireReceipt ? 'unknown' : 'enqueued';
      if (status === 'unknown') error = 'missing sp receipt';
    } else {
      const verdict = await verifySpReceipt(receipt, {
        domain,
        expectedSp: extra.spAddress,
        mandateDigest: digest,
        mandateDeadline: mandate.deadline,
        now: this.now(),
        maxWindowSeconds: extra.settleWindowSeconds + 60,
      });
      if (verdict.ok) status = 'enqueued';
      else {
        status = 'unknown';
        error = `invalid_sp_receipt: ${verdict.reason}`;
      }
    }
    // An enqueued mandate is irrevocable for the payer: the budget governs
    // commitments, not cash flow, so the reservation becomes spend either way.
    this.adjustBudget(im.id, { pending: -amount, spent: amount });
    record({
      httpStatus: second.status,
      status,
      ...(receipt ? { spReceipt: receipt } : {}),
      ...(error ? { error } : {}),
    });
    return rewrap(second, bodyBytes);
  }

  /**
   * Settles the fate of ledger entries against the chain: a consumed nonce
   * means 'settled' (tx hash from the Settled event when found); a deadline
   * passed without use means 'expired-unused' (budget released; for a mandate
   * the SP had receipted this is an SP default, unless the payer revoked the
   * SP before the receipt could be kept: `payer_revoked`). Entries still
   * inside their window stay pending, as does everything when the RPC is
   * unreachable.
   */
  async reconcile(): Promise<{ settled: Hex[]; expiredUnused: Hex[]; stillPending: Hex[] }> {
    const settled: Hex[] = [];
    const expiredUnused: Hex[] = [];
    const stillPending: Hex[] = [];
    const entries = this.ledger
      .read()
      .filter((e) => e.status === 'enqueued' || e.status === 'rejected' || e.status === 'unknown');

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const amount = BigInt(e.amount);
      const expired = this.now() > e.mandate.deadline + 60; // grace for clock skew
      let used: boolean;
      let revoked = false;
      try {
        used = await this.publicClient.readContract({
          address: e.walletContract,
          abi: AEP2_DEBIT_WALLET_ABI,
          functionName: 'usedNonces',
          args: [e.payer, BigInt(e.mandate.nonce)],
        });
        // A receipted mandate that expired unused is the SP's default only if the
        // SP stayed authorized through its promise (`enqueueDeadline`): a payer
        // revocation that takes effect at or before it made the receipt unkeepable.
        if (!used && expired && e.status === 'enqueued' && e.spReceipt) {
          revoked = await this.revokedBy(e, e.spReceipt.sp, e.spReceipt.enqueueDeadline);
        }
      } catch {
        // RPC unreachable: keep this and every remaining entry as-is.
        for (const rest of entries.slice(i)) stillPending.push(rest.mandateDigest);
        break;
      }

      if (used) {
        const settledTx = await this.findSettledTx(e);
        if (reservationHeld(e)) this.adjustBudget(e.intentMandateId, { pending: -amount, spent: amount });
        this.ledger.updateStatus(e.mandateDigest, 'settled', settledTx ? { settledTx } : undefined);
        settled.push(e.mandateDigest);
      } else if (expired) {
        if (e.status === 'enqueued') {
          // The SP promised (receipt) and did not deliver: give the budget back.
          this.adjustBudget(e.intentMandateId, { spent: -amount });
          this.ledger.updateStatus(e.mandateDigest, 'expired-unused', {
            ...(revoked ? {} : { spDefault: true }),
            error: revoked
              ? `${PAYER_REVOKED_MARK}: the payer revoked the settlement processor before its settlement deadline`
              : `${SP_DEFAULT_MARK}: settlement processor did not settle before the mandate deadline`,
          });
        } else if (reservationHeld(e)) {
          this.adjustBudget(e.intentMandateId, { pending: -amount });
          this.ledger.updateStatus(e.mandateDigest, 'expired-unused');
        } else {
          this.adjustBudget(e.intentMandateId, { spent: -amount });
          this.ledger.updateStatus(e.mandateDigest, 'expired-unused');
        }
        expiredUnused.push(e.mandateDigest);
      } else {
        stillPending.push(e.mandateDigest);
      }
    }
    return { settled, expiredUnused, stillPending };
  }

  report(): SpendReport {
    const totals = { spent: 0n, pending: 0n, enqueued: 0, settled: 0, rejected: 0, unknown: 0, expiredUnused: 0, spDefaults: 0 };
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
        case 'enqueued':
          totals.enqueued++;
          break;
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
          // lines written before the flag existed only carry the error prefix
          if (e.spDefault || e.error?.startsWith(SP_DEFAULT_MARK)) totals.spDefaults++;
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
      walletContract: this.walletContract,
      mandates,
      totals: { ...totals, spent: totals.spent.toString(), pending: totals.pending.toString() },
      byHost: Object.fromEntries([...byHost].map(([k, v]) => [k, v.toString()])),
      byResource: Object.fromEntries([...byResource].map(([k, v]) => [k, v.toString()])),
      policyDenials: this.policyDenials.map((d) => ({ ...d })),
    };
  }

  // ------------------------------------------------------------- internals

  private async walletTx(
    functionName: 'authorizeSP' | 'revokeSP' | 'cancelRevoke' | 'requestWithdraw' | 'cancelWithdraw' | 'executeWithdraw',
    args: readonly unknown[],
  ): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      address: this.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName,
      args: args as never,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

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
   * mandates) so the two crash windows of fetch() heal themselves — a
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

  /** First offer we can honour: aep2 on our network, token and debit-wallet contract, from a trusted SP. */
  private chooseOffer(accepts: unknown[], url: string): PaymentRequirements {
    const candidates = accepts.filter((o): o is PaymentRequirements => this.isSupportedOffer(o));
    if (candidates.length === 0) {
      this.deny(
        'unsupported_offer',
        { network: this.network, asset: this.token, wallet: this.walletContract, offered: accepts.length },
        url,
      );
    }
    const offer = candidates[0];
    if (this.trustedSps && !this.trustedSps.some((sp) => eqAddr(sp, offer.extra.spAddress))) {
      this.deny('sp_not_trusted', { spAddress: offer.extra.spAddress, trustedSps: this.trustedSps }, url);
    }
    return offer;
  }

  private isSupportedOffer(o: unknown): boolean {
    if (typeof o !== 'object' || o === null) return false;
    const x = o as Partial<PaymentRequirements>;
    const extra = x.extra as Partial<PaymentRequirements['extra']> | undefined;
    return (
      x.scheme === 'aep2' &&
      x.network === this.network &&
      typeof x.asset === 'string' &&
      eqAddr(x.asset, this.token) &&
      typeof x.amount === 'string' &&
      /^\d+$/.test(x.amount) &&
      BigInt(x.amount) > 0n &&
      typeof x.payTo === 'string' &&
      isAddress(x.payTo, { strict: false }) &&
      typeof x.resource === 'string' &&
      x.resource.length > 0 &&
      typeof extra === 'object' &&
      extra !== null &&
      typeof extra.wallet === 'string' &&
      eqAddr(extra.wallet, this.walletContract) &&
      typeof extra.sp === 'string' &&
      typeof extra.spAddress === 'string' &&
      isAddress(extra.spAddress, { strict: false }) &&
      typeof extra.settleWindowSeconds === 'number' &&
      Number.isInteger(extra.settleWindowSeconds) &&
      extra.settleWindowSeconds >= 0
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

  private async querySpStatus(spUrl: string, digest: Hex): Promise<string | undefined> {
    try {
      const res = await this.fetchImpl(`${spUrl.replace(/\/+$/, '')}/status/${digest}`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { status?: unknown };
      return typeof body.status === 'string' ? body.status : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether a revocation of `sp` by the entry's payer takes effect at or before `deadline` (unix seconds). */
  private async revokedBy(e: LedgerEntry, sp: Address, deadline: number): Promise<boolean> {
    const [, revokeAt] = await this.publicClient.readContract({
      address: e.walletContract,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'authorizationOf',
      args: [e.payer, sp],
    });
    return revokeAt !== 0n && Number(revokeAt) <= deadline;
  }

  /** Best effort: the Settled event for this mandate's nonce, filtered by owner. */
  private async findSettledTx(e: LedgerEntry): Promise<Hex | undefined> {
    try {
      const logs = await this.publicClient.getContractEvents({
        address: e.walletContract,
        abi: AEP2_DEBIT_WALLET_ABI,
        eventName: 'Settled',
        args: { owner: e.payer },
        fromBlock: 0n,
        toBlock: 'latest',
        strict: true,
      });
      const nonce = BigInt(e.mandate.nonce);
      return logs.find((l) => l.args.nonce === nonce)?.transactionHash ?? undefined;
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

/** A readable Response over bytes already consumed (same status/headers). */
function rewrap(res: Response, body: ArrayBuffer): Response {
  const canHaveBody = res.status !== 204 && res.status !== 205 && res.status !== 304;
  return new Response(canHaveBody ? body : null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
