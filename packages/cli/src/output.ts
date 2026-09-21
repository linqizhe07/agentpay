import { PayeeRejected, PolicyViolation, WireError, paymentModelContext } from '@agentpay/core';
import { ConfigError } from './config.js';

export type ExitCode = 0 | 1 | 2;

export interface CliResult {
  code: ExitCode;
  /** The single JSON document written to stdout. */
  output: unknown;
}

/** JSON.stringify with bigint support (decimal strings). */
export function toJson(value: unknown, pretty = true): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), pretty ? 2 : undefined);
}

export function ok(output: Record<string, unknown>): CliResult {
  return { code: 0, output: { ok: true, ...output } };
}

function revertReason(err: unknown): string | undefined {
  const e = err as { shortMessage?: string; message?: string; cause?: unknown };
  const text = `${e?.shortMessage ?? ''}\n${e?.message ?? ''}`;
  const m = /reverted with the following reason:\s*\n?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text) ?? /Error: ([A-Z][A-Za-z0-9_]*)\(/.exec(text);
  return m?.[1];
}

/**
 * Maps any thrown error to the CLI's JSON error envelope and exit code. A
 * TypeError is what the wallet throws for a malformed argument (a caller, a
 * context, a holder) before anything is sent, so it is a usage error (2),
 * not a business one; a RangeError (a delegation outside its parent's
 * bounds) is a business refusal (1) with its message.
 */
export function failure(err: unknown): CliResult {
  if (err instanceof ConfigError) {
    return { code: 2, output: { ok: false, error: 'config', message: err.message } };
  }
  if (err instanceof TypeError && !/fetch failed/i.test(err.message)) {
    // (undici reports an unreachable host as a TypeError too; that one stays a business error below)
    return { code: 2, output: { ok: false, error: 'usage', message: err.message } };
  }
  if (err instanceof PolicyViolation) {
    return {
      code: 1,
      output: {
        ok: false,
        error: err.reason,
        detail: err.detail ?? {},
        payment_model_context: err.payment_model_context ?? paymentModelContext(err.reason, err.detail),
      },
    };
  }
  if (err instanceof PayeeRejected) {
    return {
      code: 1,
      output: {
        ok: false,
        error: err.reason,
        status: err.status,
        body: err.body,
        payment_model_context: paymentModelContext(err.reason.split(':')[0].trim()),
      },
    };
  }
  if (err instanceof WireError) {
    return { code: 1, output: { ok: false, error: 'wire', message: err.message } };
  }
  const reason = revertReason(err);
  if (reason) {
    return {
      code: 1,
      output: {
        ok: false,
        error: 'revert',
        reason,
        message: (err as Error).message.split('\n')[0],
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, output: { ok: false, error: 'error', message } };
}
