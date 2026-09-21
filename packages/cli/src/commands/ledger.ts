import { formatUsdc } from '@agentpay/core';
import type { SpendReport } from '@agentpay/wallet';
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

/**
 * The wallet's SpendReport with a USD string beside every atomic figure
 * (`…Usd` fields, the CLI's convention), so a reader — human or model —
 * never has to divide by a million. Atomic figures stay for exact sums.
 */
export function reportWithUsd(r: SpendReport) {
  const usd = (atomic: string) => formatUsdc(BigInt(atomic));
  const map = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, usd(v)]));
  return {
    ...r,
    mandates: r.mandates.map((m) => ({
      ...m,
      limitUsd: usd(m.limitAmount),
      spentUsd: usd(m.spentAmount),
      pendingUsd: usd(m.pendingSpentAmount),
      remainingUsd: usd(m.remainingAmount),
    })),
    totals: { ...r.totals, spentUsd: usd(r.totals.spent), pendingUsd: usd(r.totals.pending) },
    byHostUsd: map(r.byHost),
    byResourceUsd: map(r.byResource),
    byChannelUsd: map(r.byChannel),
    bySessionUsd: map(r.bySession),
  };
}

/** Totals over root mandates (= the ledger), by host / resource / channel / session, every mandate's counters, policy denials. */
export async function report(ctx: CommandContext): Promise<CliResult> {
  return ok({ report: reportWithUsd(ctx.wallet().report()) });
}
