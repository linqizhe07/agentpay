import type { RequestHandler } from 'express';
import type { x402ResourceServer, SettleResultContext } from '@x402/core/server';
import type { Address, AssetDomain, SettleResponse } from '@agentpay/core';
import type { ChainReader } from './chain-reader.js';

/**
 * In-flight guard keyed by `${from}:${nonce}`: one authorization buys one
 * delivery, even while its settlement is still pending (the chain only knows
 * afterwards). `claim` must not await between check and set (the in-memory
 * store relies on Node's single-threaded loop). Entries expire server-side.
 */
export interface IdempotencyStore {
  /** Claims `key` for `ttlSeconds`; false when it is in flight or retained. */
  claim(key: string, ttlSeconds: number, now: number): boolean;
  /** Frees a claim after a failed verify / settle / handler so the same authorization can be retried. */
  release(key: string): void;
  /** Keeps `key` refused for `ttlSeconds` after a successful settlement (no facilitator round trip for replays). */
  retain(key: string, ttlSeconds: number, now: number): void;
  has(key: string): boolean;
  readonly size: number;
}

export interface FacilitatorEndpoint {
  /** Base URL: a local @agentpay/facilitator, or a hosted one such as https://x402.org/facilitator. */
  url: string;
  /**
   * HTTP timeout per facilitator call. A settle waits for the on-chain receipt,
   * so keep this above the facilitator's receipt timeout (default 35000).
   */
  timeoutMs?: number;
  /** Sent as `authorization: Bearer <token>` on /verify and /settle. */
  authToken?: string;
}

export interface PaywallOptions {
  facilitator: FacilitatorEndpoint;
  /** CAIP-2 network id: 'eip155:31337' | 'eip155:84532'. */
  network: string;
  /** The EIP-3009 token to be paid in. */
  asset: Address;
  /** Its EIP-712 domain, advertised as `extra.name/version` (the payer signs under it). */
  assetDomain: AssetDomain;
  /** Payee address (receives the settlement). */
  payTo: Address;
  /** How long a payer's authorization stays valid, i.e. how long settlement may take. Default 60. */
  maxTimeoutSeconds?: number;
  /** Attach payment_model_context hints to the initial 402 body. Default true. */
  includeHints?: boolean;
  /** Default: a fresh InMemoryIdempotencyStore shared by every route of this paywall. */
  idempotencyStore?: IdempotencyStore;
  /** Called once per settled payment, before the buffered response is sent. */
  onSettled?: (result: SettleResponse, ctx: SettleResultContext) => void;
  /** Log sink for settlement failures and cancellations; default console.error. */
  log?: (line: string) => void;
  /**
   * Send /settle calls to this facilitator one at a time (process-wide, keyed
   * by facilitator URL). Default true: a hosted facilitator settles from one
   * account and its nonce manager loses when two of our settles race. Verify
   * calls are not serialised. Set false only for a facilitator known to
   * handle concurrent settles (throughput then follows the chain, not us).
   */
  serializeSettle?: boolean;
  /**
   * JSON-RPC URL of `network`; builds the ChainReader that gates the one
   * settle retry (see `chainReader`). Ignored when `chainReader` is given.
   */
  rpcUrl?: string;
  /**
   * Answers whether an authorization is already used on chain. When set, a
   * settle refused with invalid_exact_evm_transaction_failed while the nonce
   * is still unused is retried once after `settleRetryDelayMs`. Without it
   * (no rpcUrl either) settlement failures are final.
   */
  chainReader?: ChainReader;
  /** Pause before the one settle retry (lets the facilitator's nonce manager and the node catch up). Default 1500. */
  settleRetryDelayMs?: number;
}

/**
 * What a route tells a catalogue (CDP Bazaar) about itself, carried in the
 * 402's `extensions.bazaar`. Examples are what a buyer's agent reads to form a
 * request, so keep them small: a catalogue row echoes them to every searcher.
 */
export interface DiscoveryDeclaration {
  /** Example query parameters (GET) or body (POST etc.). */
  input?: Record<string, unknown>;
  /** JSON-schema fragment (`properties`, `required`) for `input`. */
  inputSchema?: Record<string, unknown>;
  /** Example path parameters, keyed as in `routeTemplate` (`:ticker` -> `ticker`). */
  pathParams?: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  /** Marks a body route (POST, PUT, PATCH); absent = query route (GET, HEAD, DELETE). */
  bodyType?: 'json' | 'form-data' | 'text';
  /** A small example response (well under 4 KB) and optionally its schema. */
  output?: { example?: unknown; schema?: Record<string, unknown> };
  /**
   * The route with its parameters as `:name` segments, e.g.
   * '/v2/aggs/ticker/:ticker/range/1/day/:from/:to'. `charge()` is mounted
   * per route and sees only the wildcard pattern '*', so the bazaar extension
   * cannot infer it; without one the catalogue lists the resource under the
   * concrete URL that happened to be called first.
   */
  routeTemplate?: string;
}

export interface ChargeOptions {
  description?: string;
  mimeType?: string;
  /** Override for `resource.url` in the 402 (default: the request's own URL). */
  resource?: string;
  /** Per-route override of PaywallOptions.maxTimeoutSeconds. */
  maxTimeoutSeconds?: number;
  /** Declares the route to catalogues; without it the 402 carries no extensions. */
  discovery?: DiscoveryDeclaration;
}

export interface Paywall {
  /** The underlying x402 resource server (register extensions or more hooks on it). */
  server: x402ResourceServer;
  store: IdempotencyStore;
  /** Express middleware charging `price` ('$0.001'; USDC, 6 decimals) for the route it is mounted on. */
  charge(price: string, opts?: ChargeOptions): RequestHandler;
}

export type { RequestHandler };
