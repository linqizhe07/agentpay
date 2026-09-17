import { getAddress, isAddress } from 'viem';
import { readDeployment } from '@agentpay/contracts';
import type { Address, Hex } from '@agentpay/core';

/** Everything a Settlement Processor instance needs; see SP_DEFAULTS for the optional knobs. */
export interface SPConfig {
  rpcUrl: string;
  chainId: number;
  /** SP signing key (settles on-chain and signs enqueue receipts). */
  key: Hex;
  /** AEP2DebitWallet contract address. */
  wallet: Address;
  /** ERC-20s this SP settles; the first is the default for GET /queue. */
  tokens: Address[];
  /** 0 = ephemeral port. */
  port: number;
  /** Omit for memory only; else an append-only JSONL file replayed on open. */
  storePath?: string;
  /** The SP promises to settle within this many seconds of enqueueing (default 10800). */
  settleWindowSeconds?: number;
  /** Reject mandates whose deadline is closer than this (default 120). */
  minDeadlineMarginSeconds?: number;
  /** Reject mandates whose deadline is further out than this (default 86400). */
  maxDeadlineHorizonSeconds?: number;
  /** Worker period; 0 = never auto-tick (tests/demo call tick()). Default 5000. */
  batchIntervalMs?: number;
  /** Max mandates per settleBatch (default 50); reaching it triggers an immediate tick. */
  batchMax?: number;
  /** Pending mandates with less than this many seconds to their deadline are expired, never sent (default 30). */
  sendMarginSeconds?: number;
  /** Send failures tolerated per mandate before failed:send_failed (default 8). */
  maxAttempts?: number;
  /** Unix seconds; injectable for tests. */
  clock?: () => number;
  /** Log sink; default console.error. */
  log?: (line: string) => void;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Receipt polling interval in ms (default 1000; tests use ~50 against an automining node). */
  pollingIntervalMs?: number;
}

export type ResolvedSPConfig = Required<Omit<SPConfig, 'storePath'>> & { storePath?: string };

export const SP_DEFAULTS = {
  settleWindowSeconds: 10_800,
  minDeadlineMarginSeconds: 120,
  maxDeadlineHorizonSeconds: 86_400,
  batchIntervalMs: 5_000,
  batchMax: 50,
  sendMarginSeconds: 30,
  maxAttempts: 8,
  host: '127.0.0.1',
  pollingIntervalMs: 1_000,
  port: 3001,
  rpcUrl: 'http://127.0.0.1:8545',
} as const;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function defaultClock(): number {
  return Math.floor(Date.now() / 1000);
}

function checkNumber(name: string, value: number, opts: { min: number; integer?: boolean }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`config.${name} must be a number`);
  if (opts.integer !== false && !Number.isInteger(value)) throw new Error(`config.${name} must be an integer`);
  if (value < opts.min) throw new Error(`config.${name} must be >= ${opts.min}`);
  return value;
}

function checkAddress(name: string, value: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`config.${name} is not an address: ${String(value)}`);
  }
  return getAddress(value);
}

/** Applies defaults and validates; throws Error with a clear message. */
export function resolveConfig(cfg: SPConfig): ResolvedSPConfig {
  if (typeof cfg.key !== 'string' || !PRIVATE_KEY_RE.test(cfg.key)) {
    throw new Error('config.key must be a 0x-prefixed 32-byte hex private key');
  }
  if (typeof cfg.rpcUrl !== 'string' || !/^https?:\/\//.test(cfg.rpcUrl)) {
    throw new Error(`config.rpcUrl must be an http(s) URL: ${String(cfg.rpcUrl)}`);
  }
  if (!Array.isArray(cfg.tokens) || cfg.tokens.length === 0) {
    throw new Error('config.tokens must list at least one token address');
  }
  const resolved: ResolvedSPConfig = {
    rpcUrl: cfg.rpcUrl,
    chainId: checkNumber('chainId', cfg.chainId, { min: 1 }),
    key: cfg.key,
    wallet: checkAddress('wallet', cfg.wallet),
    tokens: cfg.tokens.map((t, i) => checkAddress(`tokens[${i}]`, t)),
    port: checkNumber('port', cfg.port, { min: 0 }),
    settleWindowSeconds: checkNumber('settleWindowSeconds', cfg.settleWindowSeconds ?? SP_DEFAULTS.settleWindowSeconds, { min: 1 }),
    minDeadlineMarginSeconds: checkNumber(
      'minDeadlineMarginSeconds',
      cfg.minDeadlineMarginSeconds ?? SP_DEFAULTS.minDeadlineMarginSeconds,
      { min: 0 },
    ),
    maxDeadlineHorizonSeconds: checkNumber(
      'maxDeadlineHorizonSeconds',
      cfg.maxDeadlineHorizonSeconds ?? SP_DEFAULTS.maxDeadlineHorizonSeconds,
      { min: 1 },
    ),
    batchIntervalMs: checkNumber('batchIntervalMs', cfg.batchIntervalMs ?? SP_DEFAULTS.batchIntervalMs, { min: 0 }),
    batchMax: checkNumber('batchMax', cfg.batchMax ?? SP_DEFAULTS.batchMax, { min: 1 }),
    sendMarginSeconds: checkNumber('sendMarginSeconds', cfg.sendMarginSeconds ?? SP_DEFAULTS.sendMarginSeconds, { min: 0 }),
    maxAttempts: checkNumber('maxAttempts', cfg.maxAttempts ?? SP_DEFAULTS.maxAttempts, { min: 1 }),
    clock: cfg.clock ?? defaultClock,
    log: cfg.log ?? ((line: string) => console.error(line)),
    host: cfg.host ?? SP_DEFAULTS.host,
    pollingIntervalMs: checkNumber('pollingIntervalMs', cfg.pollingIntervalMs ?? SP_DEFAULTS.pollingIntervalMs, { min: 1 }),
  };
  if (cfg.storePath) resolved.storePath = cfg.storePath;
  if (resolved.minDeadlineMarginSeconds > resolved.maxDeadlineHorizonSeconds) {
    throw new Error('config.minDeadlineMarginSeconds must not exceed config.maxDeadlineHorizonSeconds');
  }
  return resolved;
}

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Reads SP_PK, RPC_URL, CHAIN_ID, WALLET_ADDRESS, SUPPORTED_TOKENS, SP_PORT, STORE_PATH,
 * SETTLE_WINDOW, MIN_DEADLINE_MARGIN, MAX_DEADLINE_HORIZON, BATCH_INTERVAL_MS, BATCH_MAX,
 * SEND_MARGIN, MAX_ATTEMPTS. When CHAIN_ID / WALLET_ADDRESS / SUPPORTED_TOKENS are unset the
 * missing ones come from contracts/deployments/<DEPLOYMENT ?? 'localhost'>.json.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SPConfig {
  const key = env.SP_PK;
  if (!key || !PRIVATE_KEY_RE.test(key)) {
    throw new Error('SP_PK must be set to a 0x-prefixed 32-byte hex private key');
  }
  let chainId = envInt(env, 'CHAIN_ID');
  let wallet = env.WALLET_ADDRESS?.trim() || undefined;
  let tokens = env.SUPPORTED_TOKENS?.split(',').map((t) => t.trim()).filter(Boolean);
  if (chainId === undefined || !wallet || !tokens || tokens.length === 0) {
    const dep = readDeployment(env.DEPLOYMENT ?? 'localhost');
    chainId ??= dep.chainId;
    wallet ??= dep.wallet;
    if (!tokens || tokens.length === 0) tokens = [dep.usdc];
  }
  return {
    rpcUrl: env.RPC_URL?.trim() || SP_DEFAULTS.rpcUrl,
    chainId,
    key: key as Hex,
    wallet: checkAddress('wallet', wallet),
    tokens: tokens.map((t, i) => checkAddress(`tokens[${i}]`, t)),
    port: envInt(env, 'SP_PORT') ?? SP_DEFAULTS.port,
    storePath: env.STORE_PATH?.trim() || undefined,
    settleWindowSeconds: envInt(env, 'SETTLE_WINDOW'),
    minDeadlineMarginSeconds: envInt(env, 'MIN_DEADLINE_MARGIN'),
    maxDeadlineHorizonSeconds: envInt(env, 'MAX_DEADLINE_HORIZON'),
    batchIntervalMs: envInt(env, 'BATCH_INTERVAL_MS'),
    batchMax: envInt(env, 'BATCH_MAX'),
    sendMarginSeconds: envInt(env, 'SEND_MARGIN'),
    maxAttempts: envInt(env, 'MAX_ATTEMPTS'),
  };
}
