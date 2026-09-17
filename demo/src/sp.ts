/**
 * The demo settlement processor: an in-process @agentpay/sp instance with a
 * short settlement window and manual ticking, so scenarios can show the
 * "enqueued -> settled" transition deterministically.
 */
import { createSP, type SPHandle } from '@agentpay/sp';
import type { Address, Hex } from '@agentpay/core';

export interface DemoSpOptions {
  rpcUrl: string;
  chainId: number;
  key: Hex;
  wallet: Address;
  usdc: Address;
  port: number;
  storePath?: string;
  settleWindowSeconds: number;
  /** 0 = only settle when tick() is called (deterministic demo); production uses an interval. */
  batchIntervalMs?: number;
  log?: (line: string) => void;
}

export async function startSp(opts: DemoSpOptions): Promise<SPHandle> {
  const sp = createSP({
    rpcUrl: opts.rpcUrl,
    chainId: opts.chainId,
    key: opts.key,
    wallet: opts.wallet,
    tokens: [opts.usdc],
    port: opts.port,
    storePath: opts.storePath,
    settleWindowSeconds: opts.settleWindowSeconds,
    minDeadlineMarginSeconds: 30,
    batchIntervalMs: opts.batchIntervalMs ?? 0,
    batchMax: 50,
    sendMarginSeconds: 5,
    pollingIntervalMs: 50, // hardhat automines; viem's default 4s receipt polling would slow every tick
    log: opts.log ?? (() => {}),
  });
  await sp.start();
  return sp; // sp.url is populated by start()
}
