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
  | 'unsupported_offer'
  | 'timeout_too_long'
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

/**
 * Reasons a payee refuses a payment attempt: the `error` field of the
 * PAYMENT-REQUIRED header it answers with. Most come straight from the
 * facilitator (@x402/evm's vocabulary, which differs from the x402 spec
 * document's); the first three are the payee's own.
 */
export type PayeeReason =
  | 'payment_required'
  | 'replay'
  | 'settlement_failed'
  | 'invalid_exact_evm_scheme'
  | 'invalid_exact_evm_network_mismatch'
  | 'invalid_exact_evm_missing_eip712_domain'
  | 'invalid_exact_evm_recipient_mismatch'
  | 'invalid_exact_evm_signature'
  | 'invalid_exact_evm_payload_authorization_valid_before'
  | 'invalid_exact_evm_payload_authorization_valid_after'
  | 'invalid_exact_evm_payload_authorization_value_mismatch'
  | 'invalid_exact_evm_insufficient_balance'
  | 'invalid_exact_evm_nonce_already_used'
  | 'invalid_exact_evm_transaction_simulation_failed'
  | 'invalid_exact_evm_transaction_failed'
  | 'invalid_exact_evm_eip3009_not_supported'
  | 'invalid_exact_evm_token_name_mismatch'
  | 'invalid_exact_evm_token_version_mismatch'
  | 'asset_not_deployed_contract'
  | 'unexpected_verify_error'
  | 'unexpected_settle_error'
  | (string & {});

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
