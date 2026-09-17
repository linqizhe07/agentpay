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
