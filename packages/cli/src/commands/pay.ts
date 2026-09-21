import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import {
  LEDGER_STATUS_HEADER,
  NONCE_HEADER,
  holderSetFor,
  pickRejection,
  validatePaymentContext,
  type Caller,
  type MandateWallet,
  type PaymentContext,
} from '@agentpay/wallet';
import { PayeeRejected, PolicyViolation, paymentModelContext, type PolicyReason, type SettleResponse } from '@agentpay/core';
import { callerLabel, contextFromPairs, parseCaller } from '../attribution.js';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

export interface PayFlags {
  method?: string;
  body?: string;
  header?: string[];
  mandate?: string;
  prepay?: boolean;
  /** `--context k=v` values from the command line, or the object a host process already holds. */
  context?: string[] | PaymentContext;
  /** `--caller` (see CALLER_GRAMMAR), or the Caller a host process derived itself. */
  caller?: string | Caller;
}

function urlArg(positional: string[], what: string): string {
  const url = positional[0];
  if (!url) throw new ConfigError(`usage: agentpay ${what} <url>`);
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`not a URL: ${url}`);
  }
  return url;
}

function initFrom(flags: PayFlags): RequestInit {
  const headers = new Headers();
  for (const kv of flags.header ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new ConfigError(`--header expects k=v, got ${kv}`);
    headers.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const init: RequestInit = { method: (flags.method ?? (flags.body ? 'POST' : 'GET')).toUpperCase(), headers };
  if (flags.body !== undefined) {
    init.body = flags.body;
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return init;
}

/** The wallet's FetchOptions from the flags: strings are parsed (usage errors), objects are the wallet's to validate. */
export function attributionFrom(flags: Pick<PayFlags, 'context' | 'caller'>): { context?: PaymentContext; caller: Caller } {
  const context = Array.isArray(flags.context) ? contextFromPairs(flags.context) : validatePaymentContext(flags.context);
  const caller = typeof flags.caller === 'string' || flags.caller === undefined ? parseCaller(flags.caller) : flags.caller;
  return { ...(context !== undefined ? { context } : {}), caller };
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * requireMandateHost for an offer probe. fetch() refuses before its first
 * request unless a mandate the caller holds names the host; a probe is the
 * same HTTP client and leaves under the same rule. Eligibility at amount 0
 * (the price is not known yet) means signed, enabled, in its window, naming
 * the host and under its rate; the refusal is the one auto-selection would
 * surface, so the agent reads the same hints as for `pay`.
 */
function preflightOffer(wallet: MandateWallet, url: string, caller: Caller): void {
  const host = new URL(url).host;
  const detail = { host, amount: '0' };
  const deny = (reason: PolicyReason, d: Record<string, unknown>): never => {
    throw new PolicyViolation(reason, d, paymentModelContext(reason, d));
  };
  const set = holderSetFor(caller);
  const held = wallet.listMandates().filter((m) => set.has(m.holder ?? ''));
  if (held.length === 0) {
    if (caller.kind === 'principal' && wallet.listMandates().length === 0) deny('mandate_required', detail);
    deny('no_held_mandate', { caller: callerLabel(caller), ...detail });
  }
  const { eligible, rejected } = wallet.eligibleMandates({ host, amount: 0n, caller });
  if (eligible.length > 0) return;
  const r = pickRejection(rejected, held.some((m) => m.status === 'signed'), detail);
  deny(r.reason, r.detail);
}

/**
 * Prints the 402 offer for a URL without paying. Under `requireMandateHost`
 * (a host process) the probe needs a held mandate naming the host, like
 * `pay`; the plain CLI probes any URL — a human checking a price needs no
 * budget yet.
 */
export async function offer(ctx: CommandContext, positional: string[], flags: PayFlags): Promise<CliResult> {
  const url = urlArg(positional, 'offer');
  const { caller } = attributionFrom(flags); // validated even when unused: a bad caller is a usage error here as for `pay`
  if (ctx.walletOptions.requireMandateHost) preflightOffer(ctx.wallet(), url, caller);
  const res = await ctx.fetch(url, initFrom(flags));
  if (res.status !== 402) {
    return ok({ status: res.status, paid: false, note: 'resource did not ask for payment', body: await bodyOf(res) });
  }
  const body = await bodyOf(res);
  const header = res.headers.get('PAYMENT-REQUIRED');
  if (!header) return ok({ status: 402, offer: [], note: 'no PAYMENT-REQUIRED header: not an x402 resource', body });
  const required = decodePaymentRequiredHeader(header);
  return ok({
    status: 402,
    resource: required.resource,
    offer: required.accepts,
    error: required.error,
    payment_model_context:
      typeof body === 'object' && body !== null && 'payment_model_context' in body
        ? (body as { payment_model_context: unknown }).payment_model_context
        : paymentModelContext('payment_required'),
  });
}

/** Pays for a URL through the wallet (402 -> authorization -> retry) and prints the result. */
export async function pay(ctx: CommandContext, positional: string[], flags: PayFlags): Promise<CliResult> {
  const url = urlArg(positional, 'pay');
  const wallet = ctx.wallet();
  const fetchOpts = { mandateId: flags.mandate, prepay: flags.prepay === true, ...attributionFrom(flags) };
  const res = await wallet.fetch(url, initFrom(flags), fetchOpts);
  const body = await bodyOf(res);
  const nonce = res.headers.get(NONCE_HEADER);
  const entry = nonce ? ctx.ledger().read().find((e) => e.nonce.toLowerCase() === nonce.toLowerCase()) : undefined;
  let settlement: SettleResponse | undefined;
  const settlementHeader = res.headers.get('PAYMENT-RESPONSE');
  if (settlementHeader) {
    try {
      settlement = decodePaymentResponseHeader(settlementHeader);
    } catch {
      settlement = undefined;
    }
  }
  if (res.status < 200 || res.status >= 300) {
    // The reason the wallet recorded (PAYMENT-REQUIRED error, settlement errorReason, body error, or http N).
    const reason = entry?.error ?? `http_${res.status}`;
    throw new PayeeRejected(res.status, reason, body);
  }
  const paid = entry?.status === 'settled';
  return ok({
    status: res.status,
    paid,
    body,
    payment: entry
      ? {
          transaction: entry.transaction ?? settlement?.transaction ?? null,
          network: entry.network,
          payer: entry.payer,
          nonce: entry.nonce,
          intentMandateId: entry.intentMandateId,
          amount: entry.amount,
          ledgerStatus: res.headers.get(LEDGER_STATUS_HEADER) ?? entry.status,
          ...(entry.context ? { context: entry.context } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.status === 'unknown' ? { payment_model_context: paymentModelContext('unknown') } : {}),
        }
      : null,
  });
}
