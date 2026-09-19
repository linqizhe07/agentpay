import { getAddress, isAddress } from 'viem';
import { readDeployment } from '@agentpay/contracts';
import type { Address, AssetDomain, Hex } from '@agentpay/core';

/** Everything a facilitator instance needs; see FACILITATOR_DEFAULTS for the optional knobs. */
export interface FacilitatorConfig {
  rpcUrl: string;
  chainId: number;
  /** Pays gas for every settlement it broadcasts; needs ETH. */
  key: Hex;
  /** EIP-3009 assets this facilitator settles (anything else is refused before touching the chain). */
  tokens: Address[];
  /** Expected EIP-712 domain of `tokens[0]`; checked against the contract at startup when set. */
  assetDomain?: AssetDomain;
  /**
   * payTo allowlist. Unset = settle for any recipient, which on a public network
   * lets anyone spend this facilitator's gas; set it for anything but a dev chain.
   */
  payees?: Address[];
  /** 0 = ephemeral port. */
  port: number;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** How long a settlement waits for its receipt before answering settlement_pending (default 30000). */
  receiptTimeoutMs?: number;
  /** Receipt polling interval in ms (default 500: Base blocks every 2 s; tests use ~50 against an automining node). */
  pollingIntervalMs?: number;
  /** When set, /verify and /settle require `authorization: Bearer <token>`. */
  authToken?: string;
  /** Log sink; default console.error. */
  log?: (line: string) => void;
}

export interface ResolvedFacilitatorConfig extends Required<Omit<FacilitatorConfig, 'assetDomain' | 'payees' | 'authToken'>> {
  assetDomain?: AssetDomain;
  payees?: Address[];
  authToken?: string;
  /** CAIP-2 id derived from chainId. */
  network: `eip155:${number}`;
}

export const FACILITATOR_DEFAULTS = {
  host: '127.0.0.1',
  port: 3001,
  rpcUrl: 'http://127.0.0.1:8545',
  receiptTimeoutMs: 30_000,
  pollingIntervalMs: 500,
} as const;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function checkNumber(name: string, value: number, opts: { min: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`config.${name} must be an integer`);
  }
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
export function resolveConfig(cfg: FacilitatorConfig): ResolvedFacilitatorConfig {
  if (typeof cfg.key !== 'string' || !PRIVATE_KEY_RE.test(cfg.key)) {
    throw new Error('config.key must be a 0x-prefixed 32-byte hex private key');
  }
  if (typeof cfg.rpcUrl !== 'string' || !/^https?:\/\//.test(cfg.rpcUrl)) {
    throw new Error(`config.rpcUrl must be an http(s) URL: ${String(cfg.rpcUrl)}`);
  }
  if (!Array.isArray(cfg.tokens) || cfg.tokens.length === 0) {
    throw new Error('config.tokens must list at least one token address');
  }
  if (cfg.assetDomain && (typeof cfg.assetDomain.name !== 'string' || typeof cfg.assetDomain.version !== 'string')) {
    throw new Error('config.assetDomain must be { name, version }');
  }
  if (cfg.authToken !== undefined && (typeof cfg.authToken !== 'string' || cfg.authToken.trim() === '')) {
    throw new Error('config.authToken must be a non-empty string when set');
  }
  const chainId = checkNumber('chainId', cfg.chainId, { min: 1 });
  return {
    rpcUrl: cfg.rpcUrl,
    chainId,
    network: `eip155:${chainId}`,
    key: cfg.key,
    tokens: cfg.tokens.map((t, i) => checkAddress(`tokens[${i}]`, t)),
    assetDomain: cfg.assetDomain,
    payees: cfg.payees?.map((p, i) => checkAddress(`payees[${i}]`, p)),
    port: checkNumber('port', cfg.port, { min: 0 }),
    host: cfg.host ?? FACILITATOR_DEFAULTS.host,
    receiptTimeoutMs: checkNumber('receiptTimeoutMs', cfg.receiptTimeoutMs ?? FACILITATOR_DEFAULTS.receiptTimeoutMs, { min: 1 }),
    pollingIntervalMs: checkNumber('pollingIntervalMs', cfg.pollingIntervalMs ?? FACILITATOR_DEFAULTS.pollingIntervalMs, { min: 1 }),
    authToken: cfg.authToken,
    log: cfg.log ?? ((line: string) => console.error(line)),
  };
}

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function envList(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const items = env[name]?.split(',').map((t) => t.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

/**
 * Reads FACILITATOR_PK, RPC_URL, CHAIN_ID, SUPPORTED_TOKENS, USDC_DOMAIN_NAME /
 * USDC_DOMAIN_VERSION, PAYEES, FACILITATOR_PORT, HOST, RECEIPT_TIMEOUT_MS,
 * FACILITATOR_AUTH_TOKEN. Whatever of CHAIN_ID / SUPPORTED_TOKENS / the domain is
 * unset comes from packages/contracts/deployments/<DEPLOYMENT ?? 'localhost'>.json.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const key = env.FACILITATOR_PK;
  if (!key || !PRIVATE_KEY_RE.test(key)) {
    throw new Error('FACILITATOR_PK must be set to a 0x-prefixed 32-byte hex private key');
  }
  let chainId = envInt(env, 'CHAIN_ID');
  let tokens = envList(env, 'SUPPORTED_TOKENS');
  let assetDomain: AssetDomain | undefined =
    env.USDC_DOMAIN_NAME && env.USDC_DOMAIN_VERSION
      ? { name: env.USDC_DOMAIN_NAME, version: env.USDC_DOMAIN_VERSION }
      : undefined;
  if (chainId === undefined || !tokens || !assetDomain) {
    const dep = readDeployment(env.DEPLOYMENT ?? 'localhost');
    chainId ??= dep.chainId;
    tokens ??= [dep.usdc];
    assetDomain ??= dep.usdcDomain;
  }
  return {
    rpcUrl: env.RPC_URL?.trim() || FACILITATOR_DEFAULTS.rpcUrl,
    chainId,
    key: key as Hex,
    tokens: tokens.map((t, i) => checkAddress(`tokens[${i}]`, t)),
    assetDomain,
    payees: envList(env, 'PAYEES')?.map((p, i) => checkAddress(`payees[${i}]`, p)),
    port: envInt(env, 'FACILITATOR_PORT') ?? FACILITATOR_DEFAULTS.port,
    host: env.HOST?.trim() || undefined,
    receiptTimeoutMs: envInt(env, 'RECEIPT_TIMEOUT_MS'),
    authToken: env.FACILITATOR_AUTH_TOKEN?.trim() || undefined,
  };
}
