import { getAddress } from 'viem';
import { WireError, assertMandateShape, isHexSignature, type Address, type Hex, type Mandate } from '@agentpay/core';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EnqueueRequest {
  mandate: Mandate;
  payerSig: Hex;
  chainId?: number;
}

/** A refusal: HTTP status, snake_case error code, human message and hint detail. */
export interface Failure {
  status: number;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type ParseResult = { ok: true; value: EnqueueRequest } | { ok: false; failure: Failure };

export function failure(status: number, code: string, message: string, detail?: Record<string, unknown>): Failure {
  return detail ? { status, code, message, detail } : { status, code, message };
}

/**
 * Structural validation of an untrusted POST /enqueue body. Addresses are
 * checksummed and amount/nonce canonicalised (no leading zeros); none of that
 * changes the EIP-712 digest.
 */
export function parseEnqueueBody(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: failure(400, 'invalid_body', 'body must be a JSON object {mandate, payerSig}') };
  }
  const b = body as Record<string, unknown>;
  const raw = b.mandate;
  try {
    assertMandateShape(raw);
  } catch (err) {
    const message = err instanceof WireError ? err.message : 'mandate is malformed';
    return { ok: false, failure: failure(400, 'invalid_body', message) };
  }
  if (!isHexSignature(b.payerSig)) {
    return { ok: false, failure: failure(400, 'invalid_body', 'payerSig must be a 65-byte hex signature') };
  }
  let chainId: number | undefined;
  if (b.chainId !== undefined && b.chainId !== null) {
    const n =
      typeof b.chainId === 'number'
        ? b.chainId
        : typeof b.chainId === 'string' && /^\d+$/.test(b.chainId)
          ? Number(b.chainId)
          : Number.NaN;
    if (!Number.isSafeInteger(n) || n <= 0) {
      return { ok: false, failure: failure(400, 'invalid_body', 'chainId must be a positive integer') };
    }
    chainId = n;
  }
  const mandate: Mandate = {
    owner: getAddress(raw.owner),
    token: getAddress(raw.token),
    payee: getAddress(raw.payee),
    amount: BigInt(raw.amount).toString(),
    nonce: BigInt(raw.nonce).toString(),
    deadline: raw.deadline,
    ref: raw.ref.toLowerCase() as Hex,
  };
  const value: EnqueueRequest = { mandate, payerSig: b.payerSig };
  if (chainId !== undefined) value.chainId = chainId;
  return { ok: true, value };
}

export interface TermsOptions {
  chainId: number;
  tokens: readonly Address[];
  /** Unix seconds. */
  now: number;
  minDeadlineMarginSeconds: number;
  maxDeadlineHorizonSeconds: number;
}

/** Steps 2-3 of /enqueue: chain, token, params and deadline policy. Pure. */
export function checkTerms(req: EnqueueRequest, o: TermsOptions): Failure | undefined {
  const m = req.mandate;
  if (req.chainId !== undefined && req.chainId !== o.chainId) {
    return failure(400, 'unsupported_chain', `this settlement processor serves chain ${o.chainId}, not ${req.chainId}`, {
      chainId: o.chainId,
      requested: req.chainId,
    });
  }
  if (!o.tokens.some((t) => t.toLowerCase() === m.token.toLowerCase())) {
    return failure(400, 'unsupported_token', `token ${m.token} is not settled by this processor`, {
      token: m.token,
      supported: [...o.tokens],
    });
  }
  if (BigInt(m.amount) === 0n || m.payee.toLowerCase() === ZERO_ADDRESS) {
    return failure(400, 'bad_params', 'mandate.amount must be > 0 and mandate.payee must not be the zero address');
  }
  if (m.deadline < o.now + o.minDeadlineMarginSeconds) {
    return failure(
      400,
      'deadline_too_soon',
      `mandate.deadline ${m.deadline} is less than ${o.minDeadlineMarginSeconds}s after now (${o.now})`,
      { minDeadlineMarginSeconds: o.minDeadlineMarginSeconds, deadline: m.deadline, now: o.now },
    );
  }
  if (m.deadline > o.now + o.maxDeadlineHorizonSeconds) {
    return failure(
      400,
      'deadline_too_far',
      `mandate.deadline ${m.deadline} is more than ${o.maxDeadlineHorizonSeconds}s after now (${o.now})`,
      { maxDeadlineHorizonSeconds: o.maxDeadlineHorizonSeconds, deadline: m.deadline, now: o.now },
    );
  }
  return undefined;
}
