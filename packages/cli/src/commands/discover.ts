/**
 * `discover`: ask the x402 catalogue what is for sale and list only what
 * this wallet could pay. Free (nothing is sent to any seller; the catalogue
 * is a third party that sees the query text and the wallet's network, never
 * its address). The envelope is a lead, not a contract: `note` says so, and
 * the model is expected to `offer` the concrete URL before it pays.
 */
import { DEFAULT_MAX_AUTHORIZATION_VALIDITY } from '@agentpay/wallet';
import { DISCOVERY_NOTE, MAX_DISCOVER_ROWS, compactRows, listBazaar, rankRows, searchBazaar, type CompactScope } from '../bazaar.js';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

export const MAX_QUERY_CHARS = 200;

export interface DiscoverFlags {
  /** `--max-usd`: dearest resource to list, dollars. */
  'max-usd'?: string;
  /** `--limit`: rows to ask for and to answer with; clamped to MAX_DISCOVER_ROWS (the catalogue's own cap). */
  limit?: string | number;
  /** `--list`: walk `/discovery/resources` from `--offset` instead of searching. */
  list?: boolean;
  offset?: string | number;
}

function intFlag(v: string | number | undefined, what: string, fallback: number, min: number): number {
  if (v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${what} must be an integer >= ${min}, got ${JSON.stringify(v)}`);
  return n;
}

function maxUsdFlag(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!/^\$?\d+(\.\d{1,6})?$/.test(v.trim()) || Number(v.replace('$', '')) <= 0) {
    throw new ConfigError(`--max-usd: expected a dollar amount like 0.05, got ${JSON.stringify(v)}`);
  }
  return v.trim().replace(/^\$/, '');
}

function scopeOf(ctx: CommandContext, maxUsd: string | undefined): CompactScope {
  // The wallet's own terms: what `pay` would accept, at the validity it signs by default.
  return {
    network: ctx.config.network,
    token: ctx.config.token,
    assetDomain: ctx.config.tokenDomain,
    maxTimeoutSeconds: DEFAULT_MAX_AUTHORIZATION_VALIDITY,
    ...(maxUsd !== undefined ? { maxUsd } : {}),
  };
}

export async function discover(ctx: CommandContext, positional: string[], flags: DiscoverFlags): Promise<CliResult> {
  const limit = Math.min(MAX_DISCOVER_ROWS, intFlag(flags.limit, '--limit', MAX_DISCOVER_ROWS, 1));
  const maxUsd = maxUsdFlag(flags['max-usd']);
  const bazaar = ctx.config.bazaarUrl;
  const opts = ctx.config.bazaarTimeoutMs !== undefined ? { timeoutMs: ctx.config.bazaarTimeoutMs } : {};

  if (flags.list) {
    if (positional.length > 0) throw new ConfigError('discover --list takes no query (it pages the whole catalogue); drop the query or drop --list');
    const offset = intFlag(flags.offset, '--offset', 0, 0);
    const page = await listBazaar(ctx.fetch, bazaar, { offset }, opts);
    // The page keeps the catalogue's order (it is a paging cursor, not a ranking) and is only cut to the limit.
    const resources = compactRows(page.rows, scopeOf(ctx, maxUsd)).slice(0, limit);
    return ok({
      query: null,
      list: { offset, next_offset: offset + page.rows.length, ...(page.total !== undefined ? { total: page.total } : {}) },
      network: ctx.config.network,
      bazaar,
      matched: page.rows.length,
      payable: resources.length,
      partial: false,
      resources,
      note: DISCOVERY_NOTE,
    });
  }

  const query = (positional[0] ?? '').trim();
  if (!query) throw new ConfigError('usage: agentpay discover <query> [--max-usd usd --limit n --bazaar url] | discover --list [--offset n --limit n]');
  if (query.length > MAX_QUERY_CHARS) throw new ConfigError(`discover: the query is over ${MAX_QUERY_CHARS} characters`);
  const found = await searchBazaar(ctx.fetch, bazaar, { query, network: ctx.config.network, limit, ...(maxUsd !== undefined ? { maxUsdPrice: maxUsd } : {}) }, opts);
  const resources = rankRows(compactRows(found.rows, scopeOf(ctx, maxUsd))).slice(0, limit);
  return ok({
    query,
    network: ctx.config.network,
    bazaar,
    // matched: what the catalogue answered; payable: what this wallet could actually pay (the difference is other networks, upto, long timeouts).
    matched: found.rows.length,
    payable: resources.length,
    partial: found.partial,
    resources,
    note: DISCOVERY_NOTE,
  });
}
