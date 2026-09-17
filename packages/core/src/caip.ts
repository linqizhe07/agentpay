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

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
