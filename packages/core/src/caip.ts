import { WireError } from './errors.js';

/** 'eip155:31337' -> 31337. Only EVM (eip155) networks are supported. */
export function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new WireError(`unsupported network (need eip155:*): ${network}`);
  return Number(m[1]);
}

export function networkFromChainId(chainId: number): string {
  return `eip155:${chainId}`;
}

/** Human labels for the networks this project deploys to. */
export const KNOWN_NETWORKS: Record<string, string> = {
  'eip155:31337': 'hardhat',
  'eip155:84532': 'base-sepolia',
};

/** Seconds per block where it is fixed; absent for dev chains that mine on demand. */
export const BLOCK_TIME_SECONDS: Record<string, number> = {
  'eip155:84532': 2,
  'eip155:8453': 2,
};

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
