import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isAddress } from 'viem';
import { readDeployment, type DeploymentRecord } from '@agentpay/contracts';
import type { Address, Hex } from '@agentpay/core';

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
  wallet?: string;
  token?: string;
  network?: string;
  sp?: string;
  home?: string;
  deployment?: string;
}

/** Contents of $AGENTPAY_HOME/config.json (written by `agentpay init`). */
export interface StoredConfig {
  key?: Hex;
  rpcUrl?: string;
  walletContract?: Address;
  token?: Address;
  network?: string;
  trustedSps?: Address[];
  /** Deployment record name/path used to fill the blanks above. */
  deployment?: string;
}

export interface CliConfig {
  key?: Hex;
  rpcUrl: string;
  walletContract: Address;
  token: Address;
  network: string;
  trustedSps: Address[];
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

function parseSps(value: string | undefined): Address[] {
  if (!value) return [];
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of list) if (!isAddress(a, { strict: false })) throw new ConfigError(`trusted SP is not an address: ${a}`);
  return list as Address[];
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

  const walletContract = requireAddress('wallet', flags.wallet ?? env.AGENTPAY_WALLET ?? stored.walletContract ?? deployment?.wallet);
  const token = requireAddress('token', flags.token ?? env.AGENTPAY_TOKEN ?? stored.token ?? deployment?.usdc);
  const network = flags.network ?? env.AGENTPAY_NETWORK ?? stored.network ?? deployment?.network;
  const rpcUrl = flags.rpc ?? env.AGENTPAY_RPC ?? stored.rpcUrl ?? (network ? DEFAULT_RPC[network] : undefined);
  const key = (flags.key ?? env.AGENTPAY_KEY ?? stored.key) as Hex | undefined;
  const trustedSps = flags.sp !== undefined || env.AGENTPAY_SP !== undefined
    ? parseSps(flags.sp ?? env.AGENTPAY_SP)
    : (stored.trustedSps ?? []);

  const missing = [
    !walletContract && 'wallet (--wallet / AGENTPAY_WALLET)',
    !token && 'token (--token / AGENTPAY_TOKEN)',
    !network && 'network (--network / AGENTPAY_NETWORK, e.g. eip155:31337)',
    !rpcUrl && 'rpc (--rpc / AGENTPAY_RPC)',
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
    rpcUrl: rpcUrl!,
    walletContract: walletContract!,
    token: token!,
    network: network!,
    trustedSps,
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
