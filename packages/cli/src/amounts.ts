import { ConfigError } from './config.js';

/**
 * CLI amounts are always US dollars ('5', '0.25', '$0.001'; up to 6 decimals),
 * never atomic units: a human types them. The SDK receives atomic decimal
 * strings, which also sidesteps parsePrice's $1000 sanity cap on budgets.
 */
export function parseUsd(raw: string | undefined, what: string): bigint {
  const m = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec((raw ?? '').trim());
  if (!m) throw new ConfigError(`${what}: expected a dollar amount like 5, 0.25 or $0.001, got ${JSON.stringify(raw ?? '')}`);
  const atomic = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  if (atomic <= 0n) throw new ConfigError(`${what}: amount must be positive`);
  return atomic;
}

/** Same, but as the atomic decimal string the wallet SDK expects. */
export function usdToAtomicString(raw: string | undefined, what: string): string {
  return parseUsd(raw, what).toString();
}
