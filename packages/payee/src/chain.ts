import { createPublicClient, http } from 'viem';
import { AEP2_DEBIT_WALLET_ABI } from '@agentpay/contracts';
import type { Address } from '@agentpay/core';
import type { MandatePaywallOptions, ReadContractClient } from './types.js';

/** The two AEP2DebitWallet views the paywall pre-checks before enqueueing. */
export interface ChainReader {
  debitableBalance(owner: Address, token: Address): Promise<bigint>;
  nonceUsed(owner: Address, nonce: bigint): Promise<boolean>;
}

const RPC_TIMEOUT_MS = 5_000;

export function chainReader(client: ReadContractClient, wallet: Address): ChainReader {
  return {
    async debitableBalance(owner, token) {
      const v: unknown = await client.readContract({
        address: wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'debitableBalance',
        args: [owner, token],
      });
      return BigInt(v as bigint | number | string);
    },
    async nonceUsed(owner, nonce) {
      const v: unknown = await client.readContract({
        address: wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'usedNonces',
        args: [owner, nonce],
      });
      return Boolean(v);
    },
  };
}

/**
 * Decides whether on-chain pre-checks run (explicit `verifyOnChain`, else only
 * on the local hardhat network when a client or RPC URL is available) and
 * builds the reader. Throws when verification is requested without a source.
 */
export function resolveChainReader(options: MandatePaywallOptions): ChainReader | undefined {
  const hasSource = options.publicClient !== undefined || (typeof options.rpcUrl === 'string' && options.rpcUrl !== '');
  const verify = options.verifyOnChain ?? (options.network === 'eip155:31337' && hasSource);
  if (!verify) return undefined;
  if (!hasSource) {
    throw new Error('createMandatePaywall: verifyOnChain requires options.publicClient or options.rpcUrl');
  }
  const client: ReadContractClient =
    options.publicClient ??
    createPublicClient({ transport: http(options.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }) });
  return chainReader(client, options.wallet);
}
