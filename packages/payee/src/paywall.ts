import { paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorConfig, type RouteConfig } from '@x402/core/server';
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements, type SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { X402_SCHEME, parsePrice, paymentModelContext, type Address, type Hex } from '@agentpay/core';
import { createChainReader } from './chain-reader.js';
import { settleLockFor, type SendLock } from './settle-lock.js';
import { InMemoryIdempotencyStore } from './store.js';
import type { ChargeOptions, Paywall, PaywallOptions } from './types.js';

export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 35_000;
export const DEFAULT_SETTLE_RETRY_DELAY_MS = 1500;
/** The facilitator reason that means "the transfer did not go through" and may be worth one retry. */
const TRANSACTION_FAILED = 'invalid_exact_evm_transaction_failed';
/** How long a settled authorization stays refused locally after its own validity ends. */
const RETAIN_GRACE_SECONDS = 60;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** `${from}:${nonce}` of an exact/EVM payload, or undefined when it is not shaped like one. */
function inflightKey(payload: { readonly payload?: unknown }): string | undefined {
  const p = payload.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined;
  const from = p?.authorization?.from;
  const nonce = p?.authorization?.nonce;
  if (typeof from !== 'string' || typeof nonce !== 'string') return undefined;
  return `${from}:${nonce}`.toLowerCase();
}

/** The authorization fields an exact/EVM payload carries, or undefined when it is not shaped like one. */
function authorizationOf(payload: { readonly payload?: unknown }): { from: Address; nonce: Hex } | undefined {
  const a = (payload.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined)?.authorization;
  return ADDRESS_RE.test(String(a?.from)) && /^0x[0-9a-fA-F]{64}$/.test(String(a?.nonce)) ? { from: a!.from as Address, nonce: a!.nonce as Hex } : undefined;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The official HTTP facilitator client with /settle behind a lock. /verify is
 * a read and stays concurrent; /settle broadcasts from the facilitator's one
 * account, and a hosted facilitator's nonce manager loses when two of ours
 * arrive together. `settle` is a plain method on the base class, so overriding
 * it is enough: core's settleWithPendingRetry and our retry both go through it.
 */
export class LockedFacilitatorClient extends HTTPFacilitatorClient {
  constructor(
    config: FacilitatorConfig,
    private readonly lock: SendLock,
  ) {
    super(config);
  }

  override settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.lock(() => super.settle(paymentPayload, paymentRequirements));
  }
}

/**
 * One x402 resource server (facilitator client, `exact` scheme on one chain,
 * shared in-flight guard) that `charge()` turns into express middleware per
 * route. The middleware is @x402/express's: it answers 402 with the offer,
 * verifies through the facilitator before the handler, settles after the
 * handler succeeded (the response is buffered until then) and sets
 * PAYMENT-RESPONSE, or answers 402 when settlement fails.
 */
export function createPaywall(options: PaywallOptions): Paywall {
  for (const [name, value] of [
    ['asset', options.asset],
    ['payTo', options.payTo],
  ] as const) {
    if (!ADDRESS_RE.test(value)) throw new Error(`createPaywall: ${name} is not an address: ${value}`);
  }
  if (!/^eip155:\d+$/.test(options.network)) throw new Error(`createPaywall: network must be eip155:<chainId>: ${options.network}`);
  if (!options.assetDomain?.name || !options.assetDomain?.version) throw new Error('createPaywall: assetDomain { name, version } is required');
  if (!/^https?:\/\//.test(options.facilitator?.url ?? '')) throw new Error('createPaywall: facilitator.url must be an http(s) URL');
  const defaultTimeout = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(defaultTimeout) || defaultTimeout < 1) throw new Error('createPaywall: maxTimeoutSeconds must be a positive integer');
  const settleRetryDelayMs = options.settleRetryDelayMs ?? DEFAULT_SETTLE_RETRY_DELAY_MS;
  if (!Number.isFinite(settleRetryDelayMs) || settleRetryDelayMs < 0) throw new Error('createPaywall: settleRetryDelayMs must be a non-negative number');
  const chainReader = options.chainReader ?? (options.rpcUrl ? createChainReader(options.rpcUrl) : undefined);

  const log = options.log ?? ((line: string) => console.error(line));
  const store = options.idempotencyStore ?? new InMemoryIdempotencyStore();
  const includeHints = options.includeHints ?? true;
  const authToken = options.facilitator.authToken;
  const facilitatorUrl = options.facilitator.url.replace(/\/+$/, '');
  // serializeSettle: false keeps the official client (concurrent settles);
  // the default routes every /settle through the process-wide per-URL lock.
  const facilitatorConfig: FacilitatorConfig = {
    url: facilitatorUrl,
    timeoutMs: options.facilitator.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
    ...(authToken
      ? {
          createAuthHeaders: async () => {
            const h = { authorization: `Bearer ${authToken}` };
            return { verify: h, settle: h };
          },
        }
      : {}),
  };
  const facilitator =
    (options.serializeSettle ?? true) ? new LockedFacilitatorClient(facilitatorConfig, settleLockFor(facilitatorUrl)) : new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(facilitator);
  // Registered directly rather than via registerExactEvmScheme(): V2 on one
  // chain only, no V1 handling.
  server.register(options.network as `${string}:${string}`, new ExactEvmScheme());

  const ttlFor = (requirements: { readonly maxTimeoutSeconds: number }): number =>
    requirements.maxTimeoutSeconds + RETAIN_GRACE_SECONDS;

  // One authorization buys one delivery. The chain refuses a settled nonce, but
  // between verify and settle-after-handler nothing else would stop the same
  // authorization from being served twice concurrently (here or on another
  // route with the same terms), hence the claim before verify.
  server.onBeforeVerify(async ({ paymentPayload, requirements }) => {
    const key = inflightKey(paymentPayload as PaymentPayload);
    if (!key) return undefined; // not an exact/EVM payload: the scheme will refuse it
    if (!store.claim(key, ttlFor(requirements), nowSec())) return { abort: true, reason: 'replay' };
    return undefined;
  });
  const release = ({ paymentPayload }: { paymentPayload: { readonly payload?: unknown } }): string | undefined => {
    const key = inflightKey(paymentPayload);
    if (key) store.release(key);
    return key;
  };
  // A facilitator refusal arrives as a result (isValid: false), a facilitator
  // that could not be reached as a thrown error. Both free the claim; the
  // error is recovered into a clean refusal so the client sees a reason code
  // (settlement_unavailable, or the facilitator's own when it answered 5xx)
  // instead of an exception message.
  server.onAfterVerify(async (ctx) => {
    if (!ctx.result.isValid) release(ctx);
    return undefined;
  });
  server.onVerifyFailure(async (ctx) => {
    const key = release(ctx);
    log(`payee: facilitator verify failed for ${key ?? '?'}: ${ctx.error.message}`);
    const reason = ctx.error instanceof VerifyError ? (ctx.error.invalidReason ?? 'unexpected_verify_error') : 'settlement_unavailable';
    return { recovered: true, result: { isValid: false, invalidReason: reason, invalidMessage: ctx.error.message } };
  });
  // Keys whose one settle retry has been spent, with the moment the
  // authorization (plus grace) expires: after that a replay is refused by
  // validity anyway, so the entry can go. Swept on insert like the store.
  const retried = new Map<string, number>();
  const spendRetry = (key: string, expiresAt: number): void => {
    const now = nowSec();
    for (const [k, t] of retried) if (t <= now) retried.delete(k);
    retried.set(key, expiresAt);
  };
  const failureOf = (err: Error, network: PaymentRequirements['network']): SettleResponse =>
    err instanceof SettleError
      ? { success: false, errorReason: err.errorReason ?? 'unexpected_settle_error', errorMessage: err.message, transaction: err.transaction, network: err.network, payer: err.payer }
      : { success: false, errorReason: 'settlement_unavailable', errorMessage: err.message, transaction: '', network };
  // A settle refused as invalid_exact_evm_transaction_failed is ambiguous: the
  // transfer may have reverted, or the facilitator may have lost the race for
  // its own account nonce (hosted facilitators do, under concurrency). The
  // chain settles the ambiguity: an unused nonce means no money moved, so
  // one more settle cannot double-charge. Everything else — another reason,
  // no chain reader, a used nonce, a chain we could not read, a key already
  // retried — refuses as before. The claim is held until the retry has
  // ended, so a concurrent re-presentation of the same authorization cannot
  // slip in between. A recovered result skips core's afterSettle hooks, so
  // the retry path does that hook's work (retain + onSettled) itself.
  server.onSettleFailure(async (ctx) => {
    const key = inflightKey(ctx.paymentPayload);
    let err = ctx.error;
    const auth = authorizationOf(ctx.paymentPayload);
    const requirements = ctx.requirements as PaymentRequirements;
    if (chainReader && key && auth && err instanceof SettleError && err.errorReason === TRANSACTION_FAILED && !retried.has(key)) {
      spendRetry(key, nowSec() + ttlFor(requirements));
      const used = await chainReader.authorizationUsed(requirements.asset as Address, auth.from, auth.nonce).catch((e: unknown) => {
        log(`payee: chain read failed for ${key}, not retrying settle: ${(e as Error).message}`);
        return undefined;
      });
      if (used === false) {
        log(`payee: settle failed for ${key} with the authorization still unused; retrying once in ${settleRetryDelayMs} ms`);
        await sleep(settleRetryDelayMs);
        try {
          const result = await facilitator.settle(ctx.paymentPayload as PaymentPayload, requirements);
          if (result.success) {
            store.retain(key, ttlFor(requirements), nowSec());
            options.onSettled?.(result, { ...ctx, result });
            return { recovered: true, result };
          }
          err = new SettleError(500, { ...result, errorReason: result.errorReason ?? 'unexpected_settle_error' });
        } catch (e) {
          err = e instanceof Error ? e : new Error(String(e));
        }
      }
    }
    release(ctx);
    log(`payee: facilitator settle failed for ${key ?? '?'}: ${err.message}`);
    return { recovered: true, result: failureOf(err, ctx.requirements.network) };
  });
  server.onVerifiedPaymentCanceled(async (ctx) => {
    const key = release(ctx);
    log(`payee: payment cancelled (${ctx.reason}${ctx.responseStatus ? `, handler status ${ctx.responseStatus}` : ''}) for ${key ?? '?'}`);
  });
  server.onAfterSettle(async (ctx) => {
    const key = inflightKey(ctx.paymentPayload);
    if (!ctx.result.success) {
      if (key) store.release(key);
      log(`payee: settlement refused (${ctx.result.errorReason ?? 'unknown'}) for ${key ?? '?'}`);
      return;
    }
    if (key) store.retain(key, ttlFor(ctx.requirements), nowSec());
    options.onSettled?.(ctx.result as SettleResponse, ctx);
  });

  function charge(price: string, opts: ChargeOptions = {}) {
    const amount = parsePrice(price).toString();
    const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? defaultTimeout;
    const route: RouteConfig = {
      accepts: {
        scheme: X402_SCHEME,
        network: options.network as `${string}:${string}`,
        payTo: options.payTo,
        maxTimeoutSeconds,
        // A non-default asset (MockUSDC, or USDC on a chain the scheme does not
        // know) must be priced as an AssetAmount carrying its EIP-712 domain.
        price: {
          asset: options.asset,
          amount,
          extra: { name: options.assetDomain.name, version: options.assetDomain.version, assetTransferMethod: 'eip3009' },
        },
      },
      ...(opts.resource ? { resource: opts.resource } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
      ...(includeHints
        ? {
            unpaidResponseBody: async () => ({
              contentType: 'application/json',
              body: {
                x402Version: 2,
                error: 'payment_required',
                message: `pay ${price} per call; the offer is in the PAYMENT-REQUIRED header`,
                payment_model_context: paymentModelContext('payment_required'),
              },
            }),
          }
        : {}),
    };
    return paymentMiddleware(route, server);
  }

  return { server, store, charge };
}
