import { PRINCIPAL, validatePaymentContext, type Caller, type PaymentContext } from '@agentpay/wallet';
import { ConfigError } from './config.js';

/**
 * Who is paying, as the CLI is told on the command line. The grammar mirrors
 * holderSetFor's vocabulary one to one, so a shell session can pay from what
 * was delegated to it: `principal` (the default: budgets without a holder),
 * `child:<id>@<parentSession>` (what the parent delegated to its children,
 * plus what was delegated to this session), `session:<id>`, `bot:<id>`. The
 * `@` splits at its first occurrence, so a parent session id may contain one
 * but a child id may not.
 */
export const CALLER_GRAMMAR = 'principal | child:<id>@<parentSession> | session:<id> | bot:<id>';

export function parseCaller(raw: string | undefined): Caller {
  if (raw === undefined || raw === 'principal') return PRINCIPAL;
  const m = /^(child|session|bot):(.+)$/.exec(raw);
  if (!m) throw new ConfigError(`--caller: expected ${CALLER_GRAMMAR}, got ${JSON.stringify(raw)}`);
  const kind = m[1] as 'child' | 'session' | 'bot';
  if (kind !== 'child') return { kind, id: m[2] };
  const at = m[2].indexOf('@');
  const id = at === -1 ? m[2] : m[2].slice(0, at);
  const parentSession = at === -1 ? '' : m[2].slice(at + 1);
  if (!id || !parentSession) throw new ConfigError(`--caller: a child is child:<id>@<parentSession>, got ${JSON.stringify(raw)}`);
  return { kind, id, parentSession };
}

/** The caller as the wallet's refusals name it: 'principal', 'child <id> of <parent>', 'session <id>', 'bot <id>'. */
export function callerLabel(c: Caller): string {
  switch (c.kind) {
    case 'principal':
      return 'principal';
    case 'child':
      return `child${c.id ? ` ${c.id}` : ''}${c.parentSession ? ` of ${c.parentSession}` : ''}`;
    default:
      return `${c.kind}${c.id ? ` ${c.id}` : ''}`;
  }
}

/** The k=v pairs of AGENTPAY_CONTEXT (comma-separated; a value cannot contain a comma) as `--context` values. */
export function contextPairsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AGENTPAY_CONTEXT?.trim();
  if (!raw) return [];
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * `--context k=v` values (the environment's first, so a flag overrides the
 * same key) as the PaymentContext the wallet stores on the ledger row. Only
 * the wallet's known keys pass, each a bounded string: the wallet's
 * TypeError becomes the CLI's usage error, before any request is made.
 */
export function contextFromPairs(pairs: readonly string[] | undefined): PaymentContext | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const raw: Record<string, string> = {};
  for (const kv of pairs) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new ConfigError(`--context expects k=v, got ${JSON.stringify(kv)}`);
    raw[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  try {
    return validatePaymentContext(raw);
  } catch (err) {
    throw new ConfigError(`--context: ${(err as Error).message}`);
  }
}
