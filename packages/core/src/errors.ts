import type { PaymentModelContext } from './types.js';

/** Malformed wire data: bad headers, undecodable payloads, invalid prices. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/** Payer-side reasons a payment was refused before anything was signed. */
export type PolicyReason =
  | 'mandate_required'
  | 'mandate_not_found'
  | 'no_eligible_mandate'
  | 'mandate_insufficient_budget'
  | 'mandate_expired'
  | 'mandate_disabled'
  | 'host_not_allowed'
  | 'per_call_max'
  | 'rate_limited'
  | 'sp_not_trusted'
  | 'unsupported_offer'
  | (string & {});

/** A spend-policy rule blocked an action before any signature was produced. */
export class PolicyViolation extends Error {
  constructor(
    public reason: PolicyReason,
    public detail?: Record<string, unknown>,
    public payment_model_context?: PaymentModelContext,
  ) {
    super(`policy violation: ${reason}`);
    this.name = 'PolicyViolation';
  }
}

/** Reasons a payee rejects a payment attempt (402/409 bodies). */
export type PayeeReason =
  | 'invalid_payment'
  | 'offer_mismatch'
  | 'invalid_payee'
  | 'invalid_token'
  | 'invalid_amount'
  | 'mandate_expired'
  | 'mandate_deadline_too_short'
  | 'invalid_ref'
  | 'invalid_signature'
  | 'replay'
  | 'insufficient_balance'
  | 'nonce_used'
  | 'chain_unavailable'
  | 'settlement_unavailable'
  | 'invalid_sp_receipt';

/** Error codes returned by the Settlement Processor's POST /enqueue. */
export type SpErrorCode =
  | 'invalid_body'
  | 'unsupported_chain'
  | 'unsupported_token'
  | 'bad_params'
  | 'deadline_too_soon'
  | 'deadline_too_far'
  | 'invalid_signature'
  | 'mandate_terminal'
  | 'nonce_used'
  | 'sp_not_authorized'
  | 'sp_revocation_pending'
  | 'rpc_error'
  | 'insufficient_balance';

/** Wallet-side: the payee answered a signed payment attempt with a non-2xx status. */
export class PayeeRejected extends Error {
  constructor(
    public status: number,
    public reason: string,
    public body: unknown,
  ) {
    super(`payee rejected payment (${status}): ${reason}`);
    this.name = 'PayeeRejected';
  }
}
