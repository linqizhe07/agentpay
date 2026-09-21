import { createPublicClient, http } from 'viem';
import { EIP3009_ABI, type Address, type Hex } from '@agentpay/core';

/**
 * What the paywall needs from the chain: whether an EIP-3009 authorization
 * has been consumed. It decides the one settle retry — a facilitator that
 * answered invalid_exact_evm_transaction_failed while the chain still shows
 * the nonce unused did not move the money, so settling once more cannot
 * charge the payer twice; a used nonce means the transfer happened (the
 * facilitator's receipt path lost it) and a retry would just be refused.
 */
export interface ChainReader {
  /** `authorizationState(from, nonce)` on `asset`. Rejects when the chain cannot be read. */
  authorizationUsed(asset: Address, from: Address, nonce: Hex): Promise<boolean>;
}

export interface ChainReaderOptions {
  /** HTTP timeout per read; default 5000. A read that hangs would hold the settle retry, and with it the payer's response. */
  timeoutMs?: number;
}

/** A viem-backed ChainReader over one JSON-RPC URL (no chain object needed: authorizationState is a plain eth_call). */
export function createChainReader(rpcUrl: string, opts: ChainReaderOptions = {}): ChainReader {
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error(`createChainReader: rpcUrl must be an http(s) URL: ${rpcUrl}`);
  // retryCount 0: the retry decision must be quick and honest; a flaky RPC
  // answers "unknown" (the read rejects) and the paywall then does not retry.
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: opts.timeoutMs ?? 5_000 }) });
  return {
    authorizationUsed: (asset, from, nonce) =>
      client.readContract({ address: asset, abi: EIP3009_ABI, functionName: 'authorizationState', args: [from, nonce] }),
  };
}
