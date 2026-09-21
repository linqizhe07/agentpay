import { formatUsdc } from '@agentpay/core';
import type { IntentMandate, IntentMandateInput } from '@agentpay/wallet';
import { usdToAtomicString } from '../amounts.js';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

export interface MandateFlags {
  purpose?: string;
  limit?: string;
  hosts?: string;
  'valid-for'?: string;
  category?: string;
  'per-call'?: string;
  rate?: string;
}

export interface DelegateFlags extends MandateFlags {
  parent?: string;
  holder?: string;
}

/** A root mandate lives a day by default; a delegated one an hour (its parent bounds it at 24 h anyway). */
export const DEFAULT_VALID_FOR_SECONDS = 86_400;
export const DEFAULT_DELEGATED_VALID_FOR_SECONDS = 3_600;

function inputFrom(flags: MandateFlags, defaults: { validFor: number; purpose?: string; hosts?: readonly string[] } = { validFor: DEFAULT_VALID_FOR_SECONDS }): IntentMandateInput {
  const purpose = flags.purpose ?? defaults.purpose;
  if (!purpose) throw new ConfigError('--purpose "<what this budget is for>" is required');
  if (!flags.limit) throw new ConfigError('--limit <usd> is required');
  const hosts = flags.hosts ? flags.hosts.split(',').map((h) => h.trim()).filter(Boolean) : defaults.hosts;
  if (!hosts) throw new ConfigError('--hosts <host[,host…]> is required (use "*" only if the user explicitly allows any host)');
  const validFor = Number(flags['valid-for'] ?? defaults.validFor);
  if (!Number.isInteger(validFor) || validFor <= 0) throw new ConfigError('--valid-for must be a positive number of seconds');
  const input: IntentMandateInput = {
    naturalLanguage: purpose,
    limitAmount: usdToAtomicString(flags.limit, '--limit'),
    validForSeconds: validFor,
    hostAllowlist: [...hosts],
  };
  if (flags.category) input.category = flags.category;
  if (flags['per-call']) input.perCallMax = usdToAtomicString(flags['per-call'], '--per-call');
  if (flags.rate) {
    const rate = Number(flags.rate);
    if (!Number.isInteger(rate) || rate <= 0) throw new ConfigError('--rate must be a positive integer (calls per minute)');
    input.maxCallsPerMinute = rate;
  }
  return input;
}

/**
 * A mandate as the CLI prints it: the row (parentId and holder included when
 * it is a delegated one) plus `remainingAmount`, which is the EFFECTIVE
 * remaining budget — the tightest on its chain, what it can actually spend —
 * not `limit - spent - pending` of the row alone.
 */
export function view(m: IntentMandate, remaining: bigint) {
  return {
    ...m,
    remainingAmount: remaining.toString(),
    limitUsd: formatUsdc(BigInt(m.limitAmount)),
    spentUsd: formatUsdc(BigInt(m.spentAmount)),
    remainingUsd: formatUsdc(remaining),
    validUntilIso: new Date(m.validUntil * 1000).toISOString(),
  };
}

function idArg(positional: string[], what: string): string {
  const id = positional[0];
  if (!id) throw new ConfigError(`usage: agentpay ${what} <mandateId>`);
  return id;
}

/** Agent-facing: creates a DRAFT the human must approve. */
export async function mandateRequest(ctx: CommandContext, _p: string[], flags: MandateFlags): Promise<CliResult> {
  const wallet = ctx.wallet();
  const m = await wallet.createIntentMandate(inputFrom(flags));
  return ok({
    mandate: view(m, wallet.remaining(m.id)),
    next: `Draft created. Ask the user to approve it: agentpay mandate-approve ${m.id}`,
  });
}

/** Human-facing: create + approve in one step. */
export async function mandateCreate(ctx: CommandContext, _p: string[], flags: MandateFlags & { draft?: boolean }): Promise<CliResult> {
  const wallet = ctx.wallet();
  const m = await wallet.createIntentMandate(inputFrom(flags), { approve: !flags.draft });
  return ok({ mandate: view(m, wallet.remaining(m.id)) });
}

/**
 * A sub-budget under `--parent`, held by `--holder`, signed in one step (the
 * human approved the parent; the wallet refuses anything outside it). The
 * purpose defaults to the parent's plus " (delegated)", the hosts to the
 * parent's, the validity to an hour.
 */
export async function mandateDelegate(ctx: CommandContext, _p: string[], flags: DelegateFlags): Promise<CliResult> {
  if (!flags.parent) throw new ConfigError('--parent <mandateId> is required');
  if (!flags.holder) throw new ConfigError("--holder <session:<id> | children:<sessionId> | bot:<id>> is required");
  const wallet = ctx.wallet();
  const parent = wallet.getMandate(flags.parent);
  if (!parent) throw new ConfigError(`no intent mandate with id ${flags.parent}`);
  // The default validity stops with the parent: only an explicit --valid-for past it is a bound violation.
  const untilParent = parent.validUntil - Math.floor(Date.now() / 1000);
  const input = inputFrom(flags, {
    validFor: Math.max(1, Math.min(DEFAULT_DELEGATED_VALID_FOR_SECONDS, untilParent)),
    purpose: `${parent.naturalLanguage} (delegated)`,
    hosts: parent.hostAllowlist,
  });
  const m = await wallet.delegateIntentMandate(parent.id, input, flags.holder);
  return ok({ mandate: view(m, wallet.remaining(m.id)) });
}

export async function mandateApprove(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const wallet = ctx.wallet();
  const m = await wallet.approveIntentMandate(idArg(positional, 'mandate-approve'));
  return ok({ mandate: view(m, wallet.remaining(m.id)) });
}

export async function mandateEnable(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const wallet = ctx.wallet();
  const m = wallet.setEnabled(idArg(positional, 'mandate-enable'), true);
  return ok({ mandate: view(m, wallet.remaining(m.id)) });
}

export async function mandateDisable(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const wallet = ctx.wallet();
  const m = wallet.setEnabled(idArg(positional, 'mandate-disable'), false);
  return ok({ mandate: view(m, wallet.remaining(m.id)) });
}

export async function mandateList(ctx: CommandContext): Promise<CliResult> {
  const wallet = ctx.wallet();
  const mandates = wallet.listMandates().map((m) => view(m, wallet.remaining(m.id)));
  return ok({ count: mandates.length, mandates });
}

export async function mandateStatus(ctx: CommandContext, positional: string[]): Promise<CliResult> {
  const wallet = ctx.wallet();
  const id = idArg(positional, 'mandate-status');
  const m = wallet.getMandate(id);
  if (!m) throw new ConfigError(`no intent mandate with id ${id}`);
  const entries = ctx.ledger().read().filter((e) => e.intentMandateId === id);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return ok({ mandate: view(m, wallet.remaining(id)), payments: entries.length, byStatus: counts });
}
