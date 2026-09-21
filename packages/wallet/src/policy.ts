import type { PolicyReason } from '@agentpay/core';
import { hostAllowed } from './hosts.js';
import type { IntentMandate } from './mandate-store.js';

/** What a payment attempt looks like to the policy engine. */
export interface PolicyQuery {
  /** Host strings to match the allowlist against (hostname, and host:port when different). */
  hosts: readonly string[];
  /** Atomic units. */
  amount: bigint;
  /** Unix seconds. */
  now: number;
  /** Payment attempts charged to this mandate inside the sliding 60s window. */
  attemptsInWindow: (mandateId: string) => number;
}

export interface Rejection {
  reason: PolicyReason;
  detail: Record<string, unknown>;
}

/**
 * Who is paying, as the host process knows it (never as the model claims).
 * Decides which mandates are in reach at all: the holder set below is a
 * filter applied before any policy runs, so a caller is never told about a
 * budget it does not hold.
 */
export interface Caller {
  kind: 'principal' | 'child' | 'session' | 'bot';
  /** The session id (child, session) or bot id (bot). */
  id?: string;
  /** A child's parent session: it may spend what that session delegated to its children. */
  parentSession?: string;
}

export const PRINCIPAL: Caller = { kind: 'principal' };

const CALLER_KINDS: readonly Caller['kind'][] = ['principal', 'child', 'session', 'bot'];

/**
 * The holder strings whose mandates this caller may spend; '' stands for "no
 * holder" (the principal's own budgets). Principal: unheld mandates only;
 * child: what its parent delegated to its children plus what was delegated to
 * it by session id; session: by session id; bot: by bot id. An id that is
 * missing simply contributes nothing, so a caller the host could not identify
 * ends up with an empty set and a `no_held_mandate` refusal.
 */
export function holderSetFor(caller: Caller): Set<string> {
  if (typeof caller !== 'object' || caller === null || !CALLER_KINDS.includes(caller.kind)) {
    throw new TypeError(`caller.kind must be one of ${CALLER_KINDS.join(', ')}`);
  }
  const id = typeof caller.id === 'string' && caller.id.length > 0 ? caller.id : undefined;
  const parent = typeof caller.parentSession === 'string' && caller.parentSession.length > 0 ? caller.parentSession : undefined;
  const set = new Set<string>();
  switch (caller.kind) {
    case 'principal':
      set.add('');
      break;
    case 'child':
      if (parent !== undefined) set.add(`children:${parent}`);
      if (id !== undefined) set.add(`session:${id}`);
      break;
    case 'session':
      if (id !== undefined) set.add(`session:${id}`);
      break;
    case 'bot':
      if (id !== undefined) set.add(`bot:${id}`);
      break;
  }
  return set;
}

export function remainingOf(m: IntentMandate): bigint {
  return BigInt(m.limitAmount) - BigInt(m.spentAmount) - BigInt(m.pendingSpentAmount);
}

/**
 * Why this mandate cannot cover the attempt, or undefined when it can. Checks
 * run cheapest-and-most-structural first; the first failure is the answer.
 * Eligible = signed && enabled && validFrom <= now < validUntil && host allowed
 * && perCallMax ok && limit - spent - pending >= amount && under its rate limit.
 */
export function mandateRejection(m: IntentMandate, q: PolicyQuery): Rejection | undefined {
  if (m.status !== 'signed' || !m.signature) {
    return { reason: 'mandate_required', detail: { mandateId: m.id, status: m.status, hint: 'awaiting approval' } };
  }
  if (!m.isEnabled) return { reason: 'mandate_disabled', detail: { mandateId: m.id } };
  if (q.now < m.validFrom || q.now >= m.validUntil) {
    return {
      reason: 'mandate_expired',
      detail: { mandateId: m.id, validFrom: m.validFrom, validUntil: m.validUntil, now: q.now },
    };
  }
  if (!hostAllowed(m.hostAllowlist, q.hosts)) {
    return {
      reason: 'host_not_allowed',
      detail: { mandateId: m.id, host: q.hosts[q.hosts.length - 1], hostAllowlist: m.hostAllowlist },
    };
  }
  if (m.perCallMax !== undefined && q.amount > BigInt(m.perCallMax)) {
    return {
      reason: 'per_call_max',
      detail: { mandateId: m.id, amount: q.amount.toString(), perCallMax: m.perCallMax },
    };
  }
  const remaining = remainingOf(m);
  if (remaining < q.amount) {
    return {
      reason: 'mandate_insufficient_budget',
      detail: {
        mandateId: m.id,
        amount: q.amount.toString(),
        remaining: remaining.toString(),
        limitAmount: m.limitAmount,
        spentAmount: m.spentAmount,
        pendingSpentAmount: m.pendingSpentAmount,
      },
    };
  }
  if (m.maxCallsPerMinute !== undefined) {
    const n = q.attemptsInWindow(m.id);
    if (n >= m.maxCallsPerMinute) {
      return {
        reason: 'rate_limited',
        detail: { mandateId: m.id, maxCallsPerMinute: m.maxCallsPerMinute, attemptsInWindow: n },
      };
    }
  }
  return undefined;
}

/**
 * The full mandateRejection over a delegation chain (the charged mandate
 * first, then its ancestors up to the root): a payment must pass every
 * member's policy, because a child's spend counts against all of them. An
 * ancestor's failure keeps its own reason code (so precedence and hints work
 * unchanged) and names the ancestor in `detail.ancestorId`. Redundant for a
 * validly delegated child — its terms are within its parent's — and what
 * protects the parent's approved terms from a hand-edited child otherwise.
 */
export function chainRejection(chain: readonly IntentMandate[], q: PolicyQuery): Rejection | undefined {
  for (let i = 0; i < chain.length; i++) {
    const r = mandateRejection(chain[i], q);
    if (r) return i === 0 ? r : { reason: r.reason, detail: { ...r.detail, mandateId: chain[0].id, ancestorId: chain[i].id } };
  }
  return undefined;
}

/**
 * When auto-selection finds no eligible mandate, the reason surfaced to the
 * agent: 'mandate_required' if nothing is signed at all, else the highest-
 * precedence reason among the per-mandate rejections.
 */
export const AUTO_SELECT_PRECEDENCE: readonly PolicyReason[] = [
  'host_not_allowed',
  'mandate_expired',
  'per_call_max',
  'mandate_insufficient_budget',
  'rate_limited',
  'mandate_disabled',
];

export function pickRejection(
  rejected: readonly { id: string; reason: PolicyReason; detail?: Record<string, unknown> }[],
  hasSignedMandates: boolean,
  fallbackDetail: Record<string, unknown>,
): Rejection {
  if (!hasSignedMandates) return { reason: 'mandate_required', detail: fallbackDetail };
  for (const reason of AUTO_SELECT_PRECEDENCE) {
    const hit = rejected.find((r) => r.reason === reason);
    if (hit) return { reason: hit.reason, detail: hit.detail ?? { ...fallbackDetail, mandateId: hit.id } };
  }
  return { reason: 'no_eligible_mandate', detail: fallbackDetail };
}

/** The attempt timestamps still inside the sliding 60s window ending at `now`. */
export function pruneWindow(attempts: readonly number[], now: number): number[] {
  const cutoff = now - 60;
  return attempts.filter((t) => t > cutoff);
}
