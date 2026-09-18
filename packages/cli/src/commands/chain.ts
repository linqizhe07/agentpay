import { isAddress } from 'viem';
import { formatUsdc, type Address } from '@agentpay/core';
import { parseUsd } from '../amounts.js';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

function amountArg(positional: string[], what: string): bigint {
  const raw = positional[0];
  if (!raw) throw new ConfigError(`usage: agentpay ${what} <usd>`);
  return parseUsd(raw, what);
}

function addressArg(positional: string[], what: string): Address {
  const raw = positional[0];
  if (!raw || !isAddress(raw, { strict: false })) throw new ConfigError(`usage: agentpay ${what} <0xaddress>`);
  return raw as Address;
}

export async function balance(ctx: CommandContext): Promise<CliResult> {
  const wallet = ctx.wallet();
  const [bal, debitable, pending] = await Promise.all([wallet.balance(), wallet.debitable(), wallet.pendingWithdrawal()]);
  return ok({
    address: wallet.address,
    walletContract: ctx.config.walletContract,
    token: ctx.config.token,
    network: ctx.config.network,
    balance: bal.toString(),
    balanceUsd: formatUsdc(bal),
    debitable: debitable.toString(),
    debitableUsd: formatUsdc(debitable),
    pendingWithdrawal: { amount: pending.amount.toString(), unlockAt: pending.unlockAt },
  });
}

export async function deposit(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const amount = amountArg(positional, 'deposit');
  const wallet = ctx.wallet();
  const txs = await wallet.deposit(amount);
  const bal = await wallet.balance();
  return ok({ deposited: amount.toString(), depositedUsd: formatUsdc(amount), ...txs, balance: bal.toString() });
}

export async function withdrawRequest(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const amount = amountArg(positional, 'withdraw-request');
  const wallet = ctx.wallet();
  const tx = await wallet.requestWithdraw(amount);
  const pending = await wallet.pendingWithdrawal();
  return ok({ requested: amount.toString(), tx, unlockAt: pending.unlockAt, unlockAtIso: new Date(pending.unlockAt * 1000).toISOString() });
}

export async function withdrawCancel(ctx: CommandContext): Promise<CliResult> {
  const tx = await ctx.wallet().cancelWithdraw();
  return ok({ tx });
}

export async function withdraw(ctx: CommandContext, _positional: string[], flags: { to?: string }): Promise<CliResult> {
  const wallet = ctx.wallet();
  const to = flags.to ? addressArg([flags.to], 'withdraw --to') : undefined;
  const tx = await wallet.executeWithdraw(to);
  const bal = await wallet.balance();
  return ok({ tx, to: to ?? wallet.address, balance: bal.toString() });
}

export async function spAuthorize(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const sp = addressArg(positional, 'sp-authorize');
  const tx = await ctx.wallet().authorizeSP(sp);
  return ok({ sp, enabled: true, tx });
}

/** The revocation takes effect at `revokeAt` (withdrawDelay later); mandates the SP already receipted still settle. */
export async function spRevoke(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const sp = addressArg(positional, 'sp-revoke');
  const wallet = ctx.wallet();
  const tx = await wallet.revokeSP(sp);
  const { revokeAt } = await wallet.authorizationOf(sp);
  return ok({ sp, tx, revokeAt, revokeAtIso: new Date(revokeAt * 1000).toISOString() });
}
