import { readDeployment } from '@agentpay/contracts';
import { ConfigError, resolveHome, readStoredConfig, writeStoredConfig, type CliFlags, type StoredConfig } from '../config.js';
import { ok, type CliResult } from '../output.js';

export interface InitFlags extends CliFlags {
  'from-deployment'?: string;
}

/** Writes $AGENTPAY_HOME/config.json from flags, env and (optionally) a deployment record. */
export async function init(flags: InitFlags, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const home = resolveHome(flags, env);
  const existing = readStoredConfig(home);
  const next: StoredConfig = { ...existing };

  const deploymentName = flags['from-deployment'] ?? flags.deployment ?? env.DEPLOYMENT;
  if (deploymentName) {
    let record;
    try {
      record = readDeployment(deploymentName);
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
    next.deployment = deploymentName;
    next.token = record.usdc;
    next.tokenDomain = { ...record.usdcDomain };
    next.network = record.network;
    if (!next.rpcUrl) next.rpcUrl = record.chainId === 31337 ? 'http://127.0.0.1:8545' : record.chainId === 84532 ? 'https://sepolia.base.org' : undefined;
  }
  if (flags.token) {
    next.token = flags.token as StoredConfig['token'];
    // a token given by hand needs its domain given by hand too
    next.tokenDomain =
      env.AGENTPAY_TOKEN_NAME && env.AGENTPAY_TOKEN_VERSION ? { name: env.AGENTPAY_TOKEN_NAME, version: env.AGENTPAY_TOKEN_VERSION } : undefined;
  }
  if (flags.network) next.network = flags.network;
  if (flags.rpc ?? env.AGENTPAY_RPC) next.rpcUrl = flags.rpc ?? env.AGENTPAY_RPC;
  if (flags.key ?? env.AGENTPAY_KEY) next.key = (flags.key ?? env.AGENTPAY_KEY) as StoredConfig['key'];

  const path = writeStoredConfig(home, next);
  const { key, ...safe } = next;
  return ok({ wrote: path, config: { ...safe, key: key ? '(stored)' : undefined } });
}
