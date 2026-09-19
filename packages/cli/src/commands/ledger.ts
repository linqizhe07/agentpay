import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

export async function ledger(ctx: CommandContext, _p: string[], flags: { status?: string }): Promise<CliResult> {
  const entries = ctx.ledger().read().filter((e) => !flags.status || e.status === flags.status);
  return ok({ path: ctx.config.ledgerPath, count: entries.length, entries });
}

export async function reconcile(ctx: CommandContext): Promise<CliResult> {
  if (!ctx.config.rpcUrl) throw new ConfigError('reconcile needs an RPC (--rpc / AGENTPAY_RPC)');
  const result = await ctx.wallet().reconcile();
  return ok({
    ...result,
    counts: {
      settled: result.settled.length,
      expiredUnused: result.expiredUnused.length,
      stillPending: result.stillPending.length,
      verified: result.verified.length,
    },
  });
}

export async function report(ctx: CommandContext): Promise<CliResult> {
  return ok({ report: ctx.wallet().report() });
}
