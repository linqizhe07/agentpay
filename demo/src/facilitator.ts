/**
 * The demo facilitator: an in-process @agentpay/facilitator instance against
 * the local chain, with fast receipt polling (hardhat automines).
 */
import { createFacilitator, type FacilitatorHandle } from '@agentpay/facilitator';
import type { Address, AssetDomain, Hex } from '@agentpay/core';

export interface DemoFacilitatorOptions {
  rpcUrl: string;
  chainId: number;
  key: Hex;
  usdc: Address;
  usdcDomain: AssetDomain;
  port: number;
  log?: (line: string) => void;
}

export async function startFacilitator(opts: DemoFacilitatorOptions): Promise<FacilitatorHandle> {
  const facilitator = createFacilitator({
    rpcUrl: opts.rpcUrl,
    chainId: opts.chainId,
    key: opts.key,
    tokens: [opts.usdc],
    assetDomain: opts.usdcDomain,
    port: opts.port,
    pollingIntervalMs: 50, // hardhat automines; the production default of 500 ms suits Base's 2 s blocks
    receiptTimeoutMs: 10_000,
    log: opts.log ?? (() => {}),
  });
  await facilitator.start();
  return facilitator; // facilitator.url is populated by start()
}
