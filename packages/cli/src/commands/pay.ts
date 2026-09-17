import { readPaymentRequired, readPaymentResponse, PayeeRejected } from '@agentpay/core';
import { ConfigError } from '../config.js';
import { ok, type CliResult } from '../output.js';
import type { CommandContext } from '../context.js';

export interface PayFlags {
  method?: string;
  body?: string;
  header?: string[];
  mandate?: string;
  prepay?: boolean;
  legacy?: boolean;
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

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Prints the 402 offer for a URL without paying. */
export async function offer(ctx: CommandContext, positional: string[], flags: PayFlags): Promise<CliResult> {
  const url = urlArg(positional, 'offer');
  const res = await ctx.fetch(url, initFrom(flags));
  if (res.status !== 402) {
    return ok({ status: res.status, paid: false, note: 'resource did not ask for payment', body: await bodyOf(res) });
  }
  const text = await res.text();
  const required = readPaymentRequired(res.headers, text);
  return ok({ status: 402, offer: required.accepts, error: required.error, payment_model_context: required.payment_model_context });
}

/** Pays for a URL through the wallet (402 -> mandate -> retry) and prints the result. */
export async function pay(ctx: CommandContext, positional: string[], flags: PayFlags): Promise<CliResult> {
  const url = urlArg(positional, 'pay');
  const wallet = ctx.wallet();
  const fetchOpts = { mandateId: flags.mandate, prepay: flags.prepay === true };
  const res = await wallet.fetch(url, initFrom(flags), fetchOpts);
  const body = await bodyOf(res);
  if (res.status < 200 || res.status >= 300) {
    const reason =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `http_${res.status}`;
    throw new PayeeRejected(res.status, reason, body);
  }
  let info;
  try {
    info = readPaymentResponse(res.headers);
  } catch {
    info = undefined;
  }
  const digest = info?.mandateDigest;
  const entry = digest ? ctx.ledger().read().find((e) => e.mandateDigest.toLowerCase() === digest.toLowerCase()) : undefined;
  return ok({
    status: res.status,
    paid: info !== undefined,
    body,
    payment: info
      ? {
          mandateDigest: info.mandateDigest,
          network: info.network,
          spReceipt: info.spReceipt,
          intentMandateId: entry?.intentMandateId,
          amount: entry?.amount,
          ledgerStatus: entry?.status,
        }
      : null,
  });
}
