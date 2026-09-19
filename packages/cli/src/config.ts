import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isAddress } from 'viem';
import { readDeployment, type DeploymentRecord } from '@agentpay/contracts';
import type { Address, AssetDomain, Hex } from '@agentpay/core';

/** Thrown for usage / configuration problems (exit code 2). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Global flags every command accepts. */
export interface CliFlags {
  key?: string;
  rpc?: string;
  token?: string;
  network?: string;
  home?: string;
  deployment?: string;
}

/** Contents of $AGENTPAY_HOME/config.json (written by `agentpay init`). */
export interface StoredConfig {
  key?: Hex;
  rpcUrl?: string;
  token?: Address;
  /** EIP-712 domain of `token` (the payer signs under it). */
  tokenDomain?: AssetDomain;
  network?: string;
  /** Deployment record name/path used to fill the blanks above. */
  deployment?: string;
}

export interface CliConfig {
  key?: Hex;
  /** Optional: `pay` signs offline; `balance` and `reconcile` need it. */
  rpcUrl?: string;
  token: Address;
  tokenDomain: AssetDomain;
  network: string;
  home: string;
  configPath: string;
  mandatesPath: string;
  ledgerPath: string;
}

const DEFAULT_RPC: Record<string, string> = {
  'eip155:31337': 'http://127.0.0.1:8545',
  'eip155:84532': 'https://sepolia.base.org',
};

export function resolveHome(flags: CliFlags, env: NodeJS.ProcessEnv): string {
  return resolve(flags.home ?? env.AGENTPAY_HOME ?? join(homedir(), '.agentpay'));
}

export function configPathIn(home: string): string {
  return join(home, 'config.json');
}

export function readStoredConfig(home: string): StoredConfig {
  const path = configPathIn(home);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredConfig;
  } catch (err) {
    throw new ConfigError(`unreadable ${path}: ${(err as Error).message}`);
  }
}

export function writeStoredConfig(home: string, config: StoredConfig): string {
  mkdirSync(home, { recursive: true });
  const path = configPathIn(home);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

function tryDeployment(name: string | undefined): DeploymentRecord | undefined {
  if (!name) return undefined;
  try {
    return readDeployment(name);
  } catch {
    return undefined;
  }
}

function domainFromEnv(env: NodeJS.ProcessEnv): AssetDomain | undefined {
  return env.AGENTPAY_TOKEN_NAME && env.AGENTPAY_TOKEN_VERSION
    ? { name: env.AGENTPAY_TOKEN_NAME, version: env.AGENTPAY_TOKEN_VERSION }
    : undefined;
}

function requireAddress(name: string, value: string | undefined): Address | undefined {
  if (value === undefined) return undefined;
  if (!isAddress(value, { strict: false })) throw new ConfigError(`${name} is not an address: ${value}`);
  return value as Address;
}

/**
 * Precedence per field: flag > env (AGENTPAY_*) > config.json > deployment record.
 * The deployment record is looked up by flag --deployment, env DEPLOYMENT,
 * config.deployment, then 'localhost' as a last resort.
 */
export function resolveConfig(flags: CliFlags, env: NodeJS.ProcessEnv): CliConfig {
  const home = resolveHome(flags, env);
  const stored = readStoredConfig(home);
  const deployment =
    tryDeployment(flags.deployment ?? env.DEPLOYMENT ?? stored.deployment) ??
    (flags.deployment || env.DEPLOYMENT || stored.deployment ? undefined : tryDeployment('localhost'));

  const token = requireAddress('token', flags.token ?? env.AGENTPAY_TOKEN ?? stored.token ?? deployment?.usdc);
  // The domain follows the token it was recorded with: an explicit token needs an explicit domain.
  const tokenDomain =
    domainFromEnv(env) ??
    (flags.token || env.AGENTPAY_TOKEN ? undefined : stored.token ? stored.tokenDomain : deployment?.usdcDomain) ??
    (token && deployment && token.toLowerCase() === deployment.usdc.toLowerCase() ? deployment.usdcDomain : undefined);
  const network = flags.network ?? env.AGENTPAY_NETWORK ?? stored.network ?? deployment?.network;
  const rpcUrl = flags.rpc ?? env.AGENTPAY_RPC ?? stored.rpcUrl ?? (network ? DEFAULT_RPC[network] : undefined);
  const key = (flags.key ?? env.AGENTPAY_KEY ?? stored.key) as Hex | undefined;

  const missing = [
    !token && 'token (--token / AGENTPAY_TOKEN)',
    token && !tokenDomain && 'token domain (AGENTPAY_TOKEN_NAME + AGENTPAY_TOKEN_VERSION, or a deployment record naming this token)',
    !network && 'network (--network / AGENTPAY_NETWORK, e.g. eip155:31337)',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigError(
      `missing configuration: ${missing.join(', ')}. Run \`agentpay init --from-deployment <name|path>\` or set the env vars.`,
    );
  }
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigError('key must be a 0x-prefixed 32-byte hex private key');
  }
  return {
    key,
    rpcUrl,
    token: token!,
    tokenDomain: tokenDomain!,
    network: network!,
    home,
    configPath: configPathIn(home),
    mandatesPath: join(home, 'mandates.json'),
    ledgerPath: join(home, 'ledger.jsonl'),
  };
}

export function requireKey(cfg: CliConfig): Hex {
  if (!cfg.key) throw new ConfigError('a payer private key is required (--key / AGENTPAY_KEY / config.json "key")');
  return cfg.key;
}
