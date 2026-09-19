import { formatUsdc } from '@agentpay/core';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

/** Where to send USDC. The payer never needs ETH: the facilitator pays gas. */
export async function address(ctx: CommandContext): Promise<CliResult> {
  const wallet = ctx.wallet();
  return ok({
    address: wallet.address,
    token: ctx.config.token,
    tokenDomain: ctx.config.tokenDomain,
    network: ctx.config.network,
    note: 'send USDC (the token above) to this address on this network; keep a small float here, this key can move all of it',
  });
}

export async function balance(ctx: CommandContext): Promise<CliResult> {
  if (!ctx.config.rpcUrl) throw new ConfigError('balance needs an RPC (--rpc / AGENTPAY_RPC)');
  const wallet = ctx.wallet();
  const bal = await wallet.balance();
  return ok({
    address: wallet.address,
    token: ctx.config.token,
    network: ctx.config.network,
    balance: bal.toString(),
    balanceUsd: formatUsdc(bal),
  });
}
