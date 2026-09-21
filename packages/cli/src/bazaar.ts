/**
 * A small typed client for the CDP x402 Bazaar (a public, unauthenticated
 * catalogue of x402 resources). Written here rather than taken from
 * `@x402/extensions`' `withBazaar`, which uses the global fetch (the CLI
 * threads its own for tests), has no timeout, no response cap and no type
 * for the `quality` block the ranking needs.
 *
 * The catalogue is untrusted input in two senses: it is someone else's data
 * (sellers write their own descriptions and examples, some rows carry 6 KB
 * output examples) and it is a network dependency the wallet must not hang
 * on. So: a bounded read (10 s, 4 MiB), a projection that copies only the
 * fields a model needs to decide what to probe (never `output.example`,
 * `schema` or `iconUrl`), lengths clamped, and a single `DiscoveryUnavailable`
 * for every way the catalogue can fail, which the CLI maps to exit 1: a
 * catalogue outage is not a wallet error and must not look like one.
 *
 * What "payable" means is the wallet's own predicate (`isPayableOffer`): a
 * row is listed only if `pay` would accept one of its offers, so the model
 * is never shown a seller it cannot pay (a mainnet-only row on a testnet
 * wallet, an `upto` row, a Permit2 row, a 900 s timeout).
 */
import { formatUsdc, type AssetDomain, type PaymentRequirements } from '@agentpay/core';
import { DEFAULT_MAX_AUTHORIZATION_VALIDITY, isPayableOffer, type PayableScope } from '@agentpay/wallet';

export const DEFAULT_BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
/** Most rows one discovery answers with (the CDP search's own maximum). */
export const MAX_DISCOVER_ROWS = 20;
/** The catalogue must answer within this, or it is unavailable (AGENTPAY_BAZAAR_TIMEOUT_MS overrides, for tests). */
export const DEFAULT_BAZAAR_TIMEOUT_MS = 10_000;
/** A catalogue page is small; anything past this is not a catalogue. */
export const MAX_BAZAAR_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_INPUT_CHARS = 500;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 32;
/** Fixed reminder on every discovery envelope: the catalogue is a lead, the 402 is the contract. */
export const DISCOVERY_NOTE =
  'Catalogue prices and terms can be stale: probe the concrete URL with wallet_offer (agentpay offer) before paying, and pay only what the 402 asks.';

/** The catalogue could not be used: unreachable, slow, a non-2xx, or a body that is not a catalogue page. */
export class DiscoveryUnavailable extends Error {
  constructor(
    message: string,
    public readonly bazaar: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DiscoveryUnavailable';
  }
}

/* ---------- the catalogue's shape (only what is read; everything else is passed over) ---------- */

export interface BazaarQuality {
  l30DaysUniquePayers?: number;
  l30DaysTotalCalls?: number;
  lastCalledAt?: string;
}

export interface BazaarInput {
  method?: string;
  type?: string;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  bodyFields?: Record<string, unknown>;
}

export interface BazaarRow {
  resource?: string;
  type?: string;
  accepts?: unknown[];
  description?: string;
  serviceName?: string;
  tags?: unknown[];
  lastUpdated?: string;
  quality?: BazaarQuality;
  extensions?: { bazaar?: { info?: { input?: BazaarInput; output?: unknown }; routeTemplate?: string; schema?: unknown } };
}

/** One row as a model sees it: what to call, what it costs, who pays it, how to shape the request. */
export interface DiscoveredResource {
  /** The resource URL as the catalogue templates it (`:symbol` / `{symbol}` are the seller's path parameters). */
  resource: string;
  method: string;
  service?: string;
  description?: string;
  price_usd: string;
  network: string;
  pay_to: string;
  max_timeout_s: number;
  payers_30d: number;
  calls_30d: number;
  last_called?: string;
  last_updated?: string;
  /** The seller's example request (`path`, `query`, `body`), or the JSON text cut short with `input_truncated`. */
  input?: Record<string, unknown> | string;
  input_truncated?: true;
  tags?: string[];
}

export interface SearchParams {
  query: string;
  network: string;
  limit: number;
  /** In dollars, as the model typed it; the catalogue filters server-side and `compactRows` again client-side. */
  maxUsdPrice?: string;
}

export interface ListParams {
  offset: number;
}

export interface BazaarClientOptions {
  timeoutMs?: number;
}

/* ---------- the fetch ---------- */

type Json = Record<string, unknown>;

/**
 * GET one catalogue endpoint, bounded in time and size, answering the
 * parsed JSON object or throwing DiscoveryUnavailable. The body is read in
 * chunks so a runaway response is abandoned at the cap rather than buffered.
 */
async function getJson(fetchImpl: typeof globalThis.fetch, bazaar: string, path: string, params: Record<string, string>, opts: BazaarClientOptions): Promise<Json> {
  const url = new URL(`${bazaar.replace(/\/+$/, '')}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BAZAAR_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : e.cause?.message ?? e.message;
    throw new DiscoveryUnavailable(`bazaar ${url.origin} unreachable: ${why}`, bazaar);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new DiscoveryUnavailable(`bazaar ${url.origin} answered ${res.status}`, bazaar, res.status);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BAZAAR_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new DiscoveryUnavailable(`bazaar ${url.origin} answered ${declared} bytes (cap ${MAX_BAZAAR_RESPONSE_BYTES})`, bazaar, res.status);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BAZAAR_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new DiscoveryUnavailable(`bazaar ${url.origin} answered more than ${MAX_BAZAAR_RESPONSE_BYTES} bytes`, bazaar, res.status);
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    if (err instanceof DiscoveryUnavailable) throw err;
    throw new DiscoveryUnavailable(`bazaar ${url.origin} body unreadable: ${(err as Error).message}`, bazaar, res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DiscoveryUnavailable(`bazaar ${url.origin} answered something that is not JSON`, bazaar, res.status);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DiscoveryUnavailable(`bazaar ${url.origin} answered a JSON value that is not a catalogue page`, bazaar, res.status);
  }
  return parsed as Json;
}

const rowsOf = (page: Json, key: string, bazaar: string): BazaarRow[] => {
  const rows = page[key];
  if (!Array.isArray(rows)) throw new DiscoveryUnavailable(`bazaar page has no ${key}[]`, bazaar);
  return rows.filter((r): r is BazaarRow => typeof r === 'object' && r !== null);
};

/** `GET /discovery/search`: semantic search scoped to the wallet's network, HTTP resources only. */
export async function searchBazaar(
  fetchImpl: typeof globalThis.fetch,
  bazaar: string,
  params: SearchParams,
  opts: BazaarClientOptions = {},
): Promise<{ rows: BazaarRow[]; partial: boolean }> {
  const q: Record<string, string> = { query: params.query, network: params.network, limit: String(params.limit), type: 'http' };
  if (params.maxUsdPrice !== undefined) q.maxUsdPrice = params.maxUsdPrice;
  const page = await getJson(fetchImpl, bazaar, '/discovery/search', q, opts);
  return { rows: rowsOf(page, 'resources', bazaar), partial: page.partialResults === true };
}

/**
 * `GET /discovery/resources`: the raw paged listing, for walking the
 * catalogue when search finds nothing. CDP ignores `network` and `limit`
 * here, so the page comes back whole and the caller filters and caps.
 */
export async function listBazaar(
  fetchImpl: typeof globalThis.fetch,
  bazaar: string,
  params: ListParams,
  opts: BazaarClientOptions = {},
): Promise<{ rows: BazaarRow[]; total?: number }> {
  const page = await getJson(fetchImpl, bazaar, '/discovery/resources', { offset: String(params.offset), limit: String(MAX_DISCOVER_ROWS) }, opts);
  const pagination = page.pagination as { total?: unknown } | undefined;
  const total = typeof pagination?.total === 'number' ? pagination.total : undefined;
  return { rows: rowsOf(page, 'items', bazaar), ...(total !== undefined ? { total } : {}) };
}

/* ---------- the projection ---------- */

export interface CompactScope extends PayableScope {
  assetDomain: AssetDomain;
  /** Offers asking for a longer authorization are skipped, like `pay` would (`timeout_too_long`). */
  maxTimeoutSeconds?: number;
  /** Rows dearer than this (dollars) are dropped even if the catalogue let them through. */
  maxUsd?: string;
}

const usd = (atomic: string): string => formatUsdc(BigInt(atomic)).replace(/^\$/, '');

const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const usdToAtomic = (dollars: string): bigint | undefined => {
  const m = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(dollars.trim());
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0') : undefined;
};

/** The seller's example request, without the `type`/`method` envelope and without empty parts. */
function inputOf(input: BazaarInput | undefined): { input?: DiscoveredResource['input']; input_truncated?: true } {
  if (!input || typeof input !== 'object') return {};
  const parts: Record<string, unknown> = {};
  const nonEmpty = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
  if (nonEmpty(input.pathParams)) parts.path = input.pathParams;
  if (nonEmpty(input.queryParams)) parts.query = input.queryParams;
  if (nonEmpty(input.bodyFields)) parts.body = input.bodyFields;
  if (Object.keys(parts).length === 0) return {};
  const text = JSON.stringify(parts);
  if (text.length <= MAX_INPUT_CHARS) return { input: parts };
  return { input: text.slice(0, MAX_INPUT_CHARS), input_truncated: true };
}

/**
 * One catalogue row as a discovery result, or undefined when this wallet
 * could not pay it: no https resource, or no offer the wallet's predicate
 * accepts within the authorization validity it signs, or dearer than the
 * caller's cap. The first acceptable offer is the one `pay` would take.
 */
export function compactRow(row: BazaarRow, scope: CompactScope): DiscoveredResource | undefined {
  if (typeof row.resource !== 'string') return undefined;
  let resource: URL;
  try {
    resource = new URL(row.resource);
  } catch {
    return undefined;
  }
  if (resource.protocol !== 'https:') return undefined;
  const cap = scope.maxTimeoutSeconds ?? DEFAULT_MAX_AUTHORIZATION_VALIDITY;
  const accepts = Array.isArray(row.accepts) ? row.accepts : [];
  const offer = accepts.find((o): o is PaymentRequirements => isPayableOffer(o, scope) && o.maxTimeoutSeconds <= cap);
  if (!offer) return undefined;
  const maxAtomic = scope.maxUsd !== undefined ? usdToAtomic(scope.maxUsd) : undefined;
  if (maxAtomic !== undefined && BigInt(offer.amount) > maxAtomic) return undefined;
  const info = row.extensions?.bazaar?.info;
  const method = typeof info?.input?.method === 'string' && info.input.method.trim() ? info.input.method.trim().toUpperCase() : 'GET';
  const q = row.quality ?? {};
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, MAX_TAGS).map((t) => cut(t.trim(), MAX_TAG_CHARS))
    : [];
  return {
    resource: row.resource,
    method,
    ...(typeof row.serviceName === 'string' && row.serviceName ? { service: cut(row.serviceName, MAX_DESCRIPTION_CHARS) } : {}),
    ...(typeof row.description === 'string' && row.description ? { description: cut(row.description, MAX_DESCRIPTION_CHARS) } : {}),
    price_usd: usd(offer.amount),
    network: offer.network,
    pay_to: offer.payTo,
    max_timeout_s: offer.maxTimeoutSeconds,
    payers_30d: typeof q.l30DaysUniquePayers === 'number' ? q.l30DaysUniquePayers : 0,
    calls_30d: typeof q.l30DaysTotalCalls === 'number' ? q.l30DaysTotalCalls : 0,
    ...(typeof q.lastCalledAt === 'string' ? { last_called: q.lastCalledAt } : {}),
    ...(typeof row.lastUpdated === 'string' ? { last_updated: row.lastUpdated } : {}),
    ...inputOf(info?.input),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** Every payable row of a page, in the page's order. */
export function compactRows(rows: BazaarRow[], scope: CompactScope): DiscoveredResource[] {
  const out: DiscoveredResource[] = [];
  for (const row of rows) {
    const r = compactRow(row, scope);
    if (r) out.push(r);
  }
  return out;
}

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Most-used first: distinct payers, then calls, then recency of the last call, then of the listing. Stable otherwise. */
export function rankRows(rows: DiscoveredResource[]): DiscoveredResource[] {
  return [...rows].sort(
    (a, b) =>
      b.payers_30d - a.payers_30d ||
      b.calls_30d - a.calls_30d ||
      time(b.last_called) - time(a.last_called) ||
      time(b.last_updated) - time(a.last_updated),
  );
}
