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
    next.walletContract = record.wallet;
    next.token = record.usdc;
    next.network = record.network;
    if (!next.rpcUrl) next.rpcUrl = record.chainId === 31337 ? 'http://127.0.0.1:8545' : record.chainId === 84532 ? 'https://sepolia.base.org' : undefined;
  }
  if (flags.wallet) next.walletContract = flags.wallet as StoredConfig['walletContract'];
  if (flags.token) next.token = flags.token as StoredConfig['token'];
  if (flags.network) next.network = flags.network;
  if (flags.rpc ?? env.AGENTPAY_RPC) next.rpcUrl = flags.rpc ?? env.AGENTPAY_RPC;
  if (flags.key ?? env.AGENTPAY_KEY) next.key = (flags.key ?? env.AGENTPAY_KEY) as StoredConfig['key'];
  if (flags.sp ?? env.AGENTPAY_SP) {
    next.trustedSps = (flags.sp ?? env.AGENTPAY_SP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as StoredConfig['trustedSps'];
  }

  const path = writeStoredConfig(home, next);
  const { key, ...safe } = next;
  return ok({ wrote: path, config: { ...safe, key: key ? '(stored)' : undefined } });
}
