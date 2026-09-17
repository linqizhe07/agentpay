// Type-only express imports — erased at compile time; the returned middleware
// is a plain (req, res, next) handler with zero runtime express dependency.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  HEADER,
  WireError,
  assertMandateShape,
  chainIdFromNetwork,
  encodeHeader,
  mandateDigest,
  parsePrice,
  paymentModelContext,
  readMandatePayment,
  recoverMandateSigner,
  resourceRef,
  verifySpReceipt,
  type Address,
  type Hex,
  type Mandate,
  type MandateDomain,
  type PayeeReason,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type ReadMandateResult,
  type SettlementInfo,
  type SpReceipt,
} from '@agentpay/core';
import { resolveChainReader } from './chain.js';
import { buildOffer } from './offer.js';
import { SpClient, SpError, type SpEnqueueResult } from './sp-client.js';
import { InMemoryIdempotencyStore } from './store.js';
import type { MandatePaywallOptions, PaymentBodyField } from './types.js';

const DEFAULT_DEADLINE_MARGIN_SECONDS = 30;
/** Clock-skew allowance on top of the settle window when checking receipt deadlines. */
const RECEIPT_WINDOW_SKEW_SECONDS = 60;
/**
 * An SP answer of created:false older than this is a replay (the payee lost its
 * idempotency state, e.g. after a restart); younger ones are this payee's own
 * retry after an SP timeout and still deliver.
 */
const REPLAY_GRACE_SECONDS = 60;

function eqAddr(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function errorReason(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0];
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || Buffer.isBuffer(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** The echoed x402 offer must be ours on every term that changes what the payer owes. */
function offerMatches(echoed: unknown, offer: PaymentRequirements): boolean {
  if (typeof echoed !== 'object' || echoed === null) return false;
  const a = echoed as Partial<PaymentRequirements>;
  return (
    a.scheme === offer.scheme &&
    a.network === offer.network &&
    eqAddr(a.asset, offer.asset) &&
    eqAddr(a.payTo, offer.payTo) &&
    a.amount === offer.amount &&
    a.resource === offer.resource &&
    eqAddr(a.extra?.wallet, offer.extra.wallet)
  );
}

/**
 * Wraps res.json so plain-object bodies carry a FluxA-style `payment` field.
 * res.send and non-object bodies are left untouched (content-type neutral).
 */
function injectPaymentField(res: Response, payment: PaymentBodyField): void {
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown): Response => {
    if (isPlainObject(body) && !('payment' in body)) return originalJson({ ...body, payment });
    return originalJson(body);
  }) as typeof res.json;
}

/**
 * AEP2 mandate paywall (plan §4). Emits x402-shaped 402 offers for scheme
 * 'aep2', validates the payer's signed one-time mandate off-chain, optionally
 * pre-checks the debit wallet on-chain, forwards the mandate to the Settlement
 * Processor, verifies the SP's signed enqueue receipt and only then lets the
 * route run — with the receipt in the PAYMENT-RESPONSE header. Settlement is
 * deferred: nothing moves on-chain during the request.
 */
export function createMandatePaywall(options: MandatePaywallOptions): RequestHandler {
  const amountAtomic = parsePrice(options.price);
  const chainId = chainIdFromNetwork(options.network);
  if (!options.sp || typeof options.sp.url !== 'string' || !options.sp.url) {
    throw new Error('createMandatePaywall: options.sp.url is required');
  }
  if (!options.sp.address) throw new Error('createMandatePaywall: options.sp.address is required');
  const settleWindow = options.sp.settleWindowSeconds;
  if (!Number.isInteger(settleWindow) || settleWindow <= 0) {
    throw new Error('createMandatePaywall: options.sp.settleWindowSeconds must be a positive integer');
  }
  for (const field of ['asset', 'payTo', 'wallet'] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(options[field] ?? '')) {
      throw new Error(`createMandatePaywall: options.${field} is not an address`);
    }
  }

  const domain: MandateDomain = { chainId, verifyingContract: options.wallet };
  const store = options.idempotencyStore ?? new InMemoryIdempotencyStore();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const includeHints = options.includeHints !== false;
  const deadlineMargin = options.deadlineMarginSeconds ?? DEFAULT_DEADLINE_MARGIN_SECONDS;
  const resourceOf = options.resourceOf ?? ((req: Request) => `${req.method} ${req.path}`);
  const chain = resolveChainReader(options);
  const sp = new SpClient({ url: options.sp.url, timeoutMs: options.sp.timeoutMs }, options.fetch);

  function hint(reason: string, detail?: Record<string, unknown>) {
    return includeHints ? { payment_model_context: paymentModelContext(reason, detail) } : {};
  }

  /** 402 with the offer in both the PAYMENT-REQUIRED header and the (identical) JSON body. */
  function sendOffer(
    res: Response,
    offer: PaymentRequirements,
    reason?: PayeeReason | 'mandate_required',
    detail?: Record<string, unknown>,
    message?: string,
  ): void {
    const body: PaymentRequiredBody = { x402Version: 2, accepts: [offer] };
    if (reason) {
      body.error = message ? `${reason}: ${message}` : reason;
      if (includeHints) body.payment_model_context = paymentModelContext(reason, detail);
    }
    res.setHeader(HEADER.required, encodeHeader(body));
    res.status(402).json(body);
  }

  function invalidPayment(res: Response, message: string): void {
    res.status(400).json({ error: `invalid_payment: ${message}`, ...hint('invalid_payment') });
  }

  async function handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    const resource = resourceOf(req);
    const quoteId = options.quoteIdOf?.(req);
    const offer = buildOffer(options, resource, quoteId);

    // 1. Read the mandate: x402 envelope (PAYMENT-SIGNATURE) or legacy X-Payment-Mandate.
    let read: ReadMandateResult | undefined;
    try {
      read = readMandatePayment(req.headers);
    } catch (err) {
      if (err instanceof WireError) {
        invalidPayment(res, err.message);
        return;
      }
      throw err;
    }
    if (!read) {
      sendOffer(res, offer, 'mandate_required');
      return;
    }

    // 2. x402 envelopes echo the offer they paid against; it must be ours.
    if (read.kind === 'x402') {
      if (read.payload.x402Version !== 2) {
        invalidPayment(res, 'unsupported x402Version');
        return;
      }
      if (!offerMatches(read.payload.accepted, offer)) {
        sendOffer(res, offer, 'offer_mismatch', undefined, 'echoed offer does not match this resource');
        return;
      }
    }

    // 3. Mandate shape and terms.
    const { mandate: rawMandate, payerSig } = read.kind === 'x402' ? read.payload.payload : read.payload;
    try {
      assertMandateShape(rawMandate);
    } catch (err) {
      if (err instanceof WireError) {
        invalidPayment(res, err.message);
        return;
      }
      throw err;
    }
    const mandate: Mandate = rawMandate;
    if (!eqAddr(mandate.payee, options.payTo)) {
      sendOffer(res, offer, 'invalid_payee', { expected: options.payTo, got: mandate.payee }, `mandate.payee must be ${options.payTo}`);
      return;
    }
    if (!eqAddr(mandate.token, options.asset)) {
      sendOffer(res, offer, 'invalid_token', { expected: options.asset, got: mandate.token }, `mandate.token must be ${options.asset}`);
      return;
    }
    const amount = BigInt(mandate.amount);
    if (amount < amountAtomic) {
      sendOffer(res, offer, 'invalid_amount', { expected: offer.amount, got: mandate.amount }, `expected >= ${offer.amount} got ${mandate.amount}`);
      return;
    }
    const t = now();
    if (mandate.deadline <= t + deadlineMargin) {
      sendOffer(res, offer, 'mandate_expired', { deadline: mandate.deadline, now: t, marginSeconds: deadlineMargin }, `deadline must exceed now + ${deadlineMargin}s`);
      return;
    }
    if (mandate.deadline < t + settleWindow) {
      sendOffer(res, offer, 'mandate_deadline_too_short', { settleWindowSeconds: settleWindow, deadline: mandate.deadline, now: t }, `deadline must be >= now + ${settleWindow}s`);
      return;
    }
    if (mandate.ref.toLowerCase() !== resourceRef(resource, quoteId).toLowerCase()) {
      sendOffer(res, offer, 'invalid_ref', { resource, quoteId }, 'ref does not commit to this resource');
      return;
    }

    // 4. The signature must recover to the owner (a malformed signature counts as invalid).
    let signer: Address;
    try {
      signer = await recoverMandateSigner(domain, mandate, payerSig);
    } catch {
      sendOffer(res, offer, 'invalid_signature', undefined, 'malformed signature');
      return;
    }
    if (!eqAddr(signer, mandate.owner)) {
      sendOffer(res, offer, 'invalid_signature', undefined, 'signature does not recover to mandate.owner');
      return;
    }

    // 5. One mandate, one delivery: claim the digest before any side effect.
    const digest: Hex = mandateDigest(domain, mandate);
    if (!store.claim(digest)) {
      res.status(409).json({ error: 'replay', mandateDigest: digest, ...hint('replay') });
      return;
    }

    // Every failure from here on must free the claim so the payer can retry the same mandate.
    let receipt: SpReceipt;
    try {
      // 6. Optional on-chain pre-check (fail closed on RPC trouble).
      if (chain) {
        let debitable: bigint;
        let used: boolean;
        try {
          [debitable, used] = await Promise.all([
            chain.debitableBalance(mandate.owner, mandate.token),
            chain.nonceUsed(mandate.owner, BigInt(mandate.nonce)),
          ]);
        } catch (err) {
          store.release(digest);
          const message = errorReason(err);
          sendOffer(res, offer, 'chain_unavailable', { message }, message);
          return;
        }
        if (debitable < amount) {
          store.release(digest);
          sendOffer(res, offer, 'insufficient_balance', { debitable: debitable.toString(), amount: mandate.amount }, `debitable ${debitable} < ${mandate.amount}`);
          return;
        }
        if (used) {
          store.release(digest);
          sendOffer(res, offer, 'nonce_used', { nonce: mandate.nonce }, 'nonce already consumed on-chain');
          return;
        }
      }

      // 7. Hand the mandate to the Settlement Processor and verify its promise.
      let enqueued: SpEnqueueResult;
      try {
        enqueued = await sp.enqueue({ mandate, payerSig });
      } catch (err) {
        store.release(digest);
        const spReason = err instanceof SpError ? err.reason : errorReason(err);
        const detail: Record<string, unknown> = { spReason, message: errorReason(err) };
        if (err instanceof SpError) {
          detail.spStatus = err.status;
          if (err.body !== undefined) detail.spBody = err.body;
        }
        sendOffer(res, offer, 'settlement_unavailable', detail, spReason);
        return;
      }
      receipt = enqueued.receipt;
      // The SP already held this mandate. Within the grace window that is our own
      // retry (an earlier attempt timed out after the SP had queued it); beyond it
      // the payer is replaying a mandate this payee has lost track of (restart,
      // other instance), and a mandate buys exactly one delivery.
      if (
        !enqueued.created &&
        enqueued.enqueuedAt !== undefined &&
        now() - enqueued.enqueuedAt > REPLAY_GRACE_SECONDS
      ) {
        store.release(digest);
        res.status(409).json({ error: 'replay', mandateDigest: digest, ...hint('replay', { enqueuedAt: enqueued.enqueuedAt }) });
        return;
      }
      const check = await verifySpReceipt(receipt, {
        domain,
        expectedSp: options.sp.address,
        mandateDigest: digest,
        mandateDeadline: mandate.deadline,
        now: now(),
        maxWindowSeconds: settleWindow + RECEIPT_WINDOW_SKEW_SECONDS,
      });
      if (!check.ok) {
        store.release(digest);
        sendOffer(res, offer, 'invalid_sp_receipt', { problem: check.reason }, check.reason);
        return;
      }
    } catch (err) {
      store.release(digest);
      throw err;
    }

    // 8. Enqueued: expose the receipt and run the route.
    const info: SettlementInfo = {
      success: true,
      scheme: 'aep2',
      network: options.network,
      payer: mandate.owner,
      transaction: '',
      status: 'enqueued',
      mandateDigest: digest,
      spReceipt: receipt,
    };
    try {
      options.onEnqueued?.(info, req);
    } catch (err) {
      // The SP already holds the mandate; freeing the claim lets a retry deliver
      // (the SP answers repeated enqueues of the same digest idempotently, and a
      // retry inside REPLAY_GRACE_SECONDS is not treated as a replay).
      store.release(digest);
      throw err;
    }
    // Only a delivered response carries the receipt: nothing above may have set it.
    res.setHeader(HEADER.response, encodeHeader(info));
    res.setHeader('Cache-Control', 'no-store, private');
    res.locals.aep2 = info;
    if (options.includeBodyPaymentField) {
      injectPaymentField(res, { status: 'enqueued', mandateDigest: digest, spReceipt: receipt });
    }
    next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    void handle(req, res, next).catch(next);
  };
}
