import { paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from '@x402/core/server';
import { SettleError, VerifyError, type PaymentPayload, type SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { X402_SCHEME, parsePrice, paymentModelContext } from '@agentpay/core';
import { InMemoryIdempotencyStore } from './store.js';
import type { ChargeOptions, Paywall, PaywallOptions } from './types.js';

export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 35_000;
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

const nowSec = (): number => Math.floor(Date.now() / 1000);

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

  const log = options.log ?? ((line: string) => console.error(line));
  const store = options.idempotencyStore ?? new InMemoryIdempotencyStore();
  const includeHints = options.includeHints ?? true;
  const authToken = options.facilitator.authToken;
  const facilitator = new HTTPFacilitatorClient({
    url: options.facilitator.url.replace(/\/+$/, ''),
    timeoutMs: options.facilitator.timeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS,
    ...(authToken
      ? {
          createAuthHeaders: async () => {
            const h = { authorization: `Bearer ${authToken}` };
            return { verify: h, settle: h };
          },
        }
      : {}),
  });

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
  server.onSettleFailure(async (ctx) => {
    const key = release(ctx);
    log(`payee: facilitator settle failed for ${key ?? '?'}: ${ctx.error.message}`);
    const err = ctx.error;
    const result: SettleResponse =
      err instanceof SettleError
        ? { success: false, errorReason: err.errorReason ?? 'unexpected_settle_error', errorMessage: err.message, transaction: err.transaction, network: err.network, payer: err.payer }
        : { success: false, errorReason: 'settlement_unavailable', errorMessage: err.message, transaction: '', network: ctx.requirements.network };
    return { recovered: true, result };
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
