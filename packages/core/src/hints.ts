import type { PayeeReason, PolicyReason } from './errors.js';
import type { PaymentModelContext } from './types.js';

export const POLICY_REASONS = [
  'mandate_required',
  'mandate_not_found',
  'no_eligible_mandate',
  'mandate_insufficient_budget',
  'mandate_expired',
  'mandate_disabled',
  'host_not_allowed',
  'per_call_max',
  'rate_limited',
  'unsupported_offer',
  'timeout_too_long',
] as const satisfies readonly PolicyReason[];

export const PAYEE_REASONS = [
  'payment_required',
  'replay',
  'settlement_failed',
  'invalid_exact_evm_scheme',
  'invalid_exact_evm_network_mismatch',
  'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_recipient_mismatch',
  'invalid_exact_evm_signature',
  'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_valid_after',
  'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_nonce_already_used',
  'invalid_exact_evm_transaction_simulation_failed',
  'invalid_exact_evm_transaction_failed',
  'invalid_exact_evm_eip3009_not_supported',
  'invalid_exact_evm_token_name_mismatch',
  'invalid_exact_evm_token_version_mismatch',
  'asset_not_deployed_contract',
  'unexpected_verify_error',
  'unexpected_settle_error',
] as const satisfies readonly PayeeReason[];

/** Wallet-side outcomes that are not refusals but still need guidance. */
export const OUTCOME_REASONS = ['unknown', 'settlement_unavailable'] as const;

interface Hint {
  summary: string;
  remediation: string[];
  commands?: string[];
}

const fmt = (detail: Record<string, unknown> | undefined, key: string, fallback = '?'): string => {
  const v = detail?.[key];
  return v === undefined || v === null ? fallback : String(v);
};

const RETRY_FRESH = 'Just call `agentpay pay` again: every attempt signs a fresh, single-use authorization.';
const PAYEE_MISCONFIGURED = 'Do not retry: the service is misconfigured. Report the reason to the user.';

const HINTS: Record<string, (d?: Record<string, unknown>) => Hint> = {
  // ---- payer-side policy ----
  mandate_required: () => ({
    summary: 'No signed intent mandate exists, so the wallet will not pay for anything yet.',
    remediation: [
      'Ask the user for a spending budget (purpose, limit, allowed hosts).',
      'Create a draft with `agentpay mandate-request` and hand the id to the user to approve.',
    ],
    commands: ['agentpay mandate-request --purpose "<why>" --limit <usd> --hosts <host>'],
  }),
  mandate_not_found: (d) => ({
    summary: `Intent mandate ${fmt(d, 'mandateId')} does not exist in this wallet.`,
    remediation: ['List mandates with `agentpay mandate-list` and pick an existing id, or omit --mandate.'],
    commands: ['agentpay mandate-list'],
  }),
  no_eligible_mandate: (d) => ({
    summary: `No enabled, unexpired mandate covers host ${fmt(d, 'host')} for ${fmt(d, 'amount')} atomic units.`,
    remediation: ['Check `agentpay mandate-list`; request a new mandate covering this host if none fits.'],
    commands: ['agentpay mandate-list', 'agentpay mandate-request --purpose "<why>" --limit <usd> --hosts <host>'],
  }),
  mandate_insufficient_budget: (d) => ({
    summary: `Remaining budget ${fmt(d, 'remaining')} is below the price ${fmt(d, 'amount')} (atomic units).`,
    remediation: [
      'Do not retry: the same call will be refused until the budget changes.',
      'Ask the user to approve a larger or additional intent mandate.',
    ],
    commands: ['agentpay mandate-status <id>', 'agentpay mandate-request --purpose "<why>" --limit <usd> --hosts <host>'],
  }),
  mandate_expired: (d) => ({
    summary: `Mandate ${fmt(d, 'mandateId', '')} is outside its validity window.`.replace('  ', ' '),
    remediation: ['Request a fresh intent mandate.'],
    commands: ['agentpay mandate-request --purpose "<why>" --limit <usd> --hosts <host>'],
  }),
  mandate_disabled: (d) => ({
    summary: `Mandate ${fmt(d, 'mandateId')} has been disabled by the user.`,
    remediation: ['Ask the user to re-enable it (`agentpay mandate-enable <id>`) or use another mandate.'],
    commands: ['agentpay mandate-list'],
  }),
  host_not_allowed: (d) => ({
    summary: `Host ${fmt(d, 'host')} is not in the mandate's allowlist.`,
    remediation: ['Use a mandate that allows this host, or ask the user for one that does.'],
    commands: ['agentpay mandate-list', 'agentpay mandate-request --purpose "<why>" --limit <usd> --hosts <host>'],
  }),
  per_call_max: (d) => ({
    summary: `Price ${fmt(d, 'amount')} exceeds the per-call cap ${fmt(d, 'perCallMax')} (atomic units).`,
    remediation: ['Do not retry the same call; ask the user to raise the per-call cap if the price is legitimate.'],
  }),
  rate_limited: (d) => ({
    summary: `Too many payment attempts in the last minute (limit ${fmt(d, 'maxCallsPerMinute')}).`,
    remediation: ['Wait a minute before retrying, or batch the work into fewer paid calls.'],
  }),
  unsupported_offer: () => ({
    summary: "The 402 offer has no x402 `exact` option for this wallet's network and USDC (or names a different token domain).",
    remediation: ['This service cannot be paid with this wallet; report the offer to the user.'],
  }),
  timeout_too_long: (d) => ({
    summary: `The offer wants an authorization valid for ${fmt(d, 'maxTimeoutSeconds')}s, above this wallet's cap of ${fmt(d, 'cap')}s.`,
    remediation: [
      'Do not retry: a long-lived authorization would tie up budget for that long if the call fails.',
      'Ask the user to raise maxAuthorizationValiditySeconds only if they trust this service.',
    ],
  }),

  // ---- payee / facilitator ----
  payment_required: () => ({
    summary: 'The resource is paid; no payment was attached.',
    remediation: ['Pay it with `agentpay pay <url>` (the wallet answers the 402 automatically).'],
    commands: ['agentpay offer <url>', 'agentpay pay <url>'],
  }),
  replay: () => ({
    summary: 'This exact authorization was already presented; an authorization pays for one delivery.',
    remediation: [RETRY_FRESH],
  }),
  settlement_failed: (d) => ({
    summary: `The payee served the call but the on-chain settlement failed: ${fmt(d, 'reason', 'unknown')}.`,
    remediation: ['Nothing was charged.', RETRY_FRESH],
  }),
  invalid_exact_evm_scheme: () => ({ summary: 'The payment does not use the `exact` scheme.', remediation: [RETRY_FRESH] }),
  invalid_exact_evm_network_mismatch: () => ({
    summary: "The authorization's network does not match the offer's.",
    remediation: ['Check the wallet is configured for the network the service charges on (AGENTPAY_NETWORK).'],
  }),
  invalid_exact_evm_missing_eip712_domain: () => ({
    summary: 'The offer does not carry the token EIP-712 domain (extra.name/version).',
    remediation: [PAYEE_MISCONFIGURED],
  }),
  invalid_exact_evm_recipient_mismatch: () => ({
    summary: 'authorization.to is not the offer payTo address.',
    remediation: [RETRY_FRESH],
  }),
  invalid_exact_evm_signature: () => ({
    summary: 'The authorization signature does not recover to the payer.',
    remediation: ['Check AGENTPAY_KEY belongs to the payer address and the token domain in the deployment record is right.'],
    commands: ['agentpay address'],
  }),
  invalid_exact_evm_payload_authorization_valid_before: () => ({
    summary: 'The authorization expired before it could be settled.',
    remediation: [RETRY_FRESH, 'If it keeps happening the service settles too slowly for its own maxTimeoutSeconds.'],
  }),
  invalid_exact_evm_payload_authorization_valid_after: () => ({
    summary: 'The authorization is not valid yet (clock skew).',
    remediation: ['Check the machine clock, then retry.'],
  }),
  invalid_exact_evm_payload_authorization_value_mismatch: () => ({
    summary: 'authorization.value differs from the offer amount.',
    remediation: ['Fetch a fresh 402 (the price changed) and pay again.'],
    commands: ['agentpay offer <url>', 'agentpay pay <url>'],
  }),
  invalid_exact_evm_insufficient_balance: () => ({
    summary: "The payer's USDC balance does not cover the price.",
    remediation: ['Ask the user to send USDC to the wallet address (`agentpay address`); no ETH is needed.'],
    commands: ['agentpay address', 'agentpay balance'],
  }),
  invalid_exact_evm_nonce_already_used: () => ({
    summary: 'This authorization was already settled on chain.',
    remediation: ['If you did not get the response, run `agentpay reconcile` to record the payment, then pay again.'],
    commands: ['agentpay reconcile', 'agentpay pay <url>'],
  }),
  invalid_exact_evm_transaction_simulation_failed: () => ({
    summary: 'The facilitator could not simulate the transfer (and could not tell why).',
    remediation: [RETRY_FRESH, 'If it persists, check the balance with `agentpay balance`.'],
    commands: ['agentpay balance'],
  }),
  invalid_exact_evm_transaction_failed: () => ({
    summary: 'The settlement transaction reverted on chain.',
    remediation: ['Nothing was charged.', RETRY_FRESH],
  }),
  invalid_exact_evm_eip3009_not_supported: () => ({
    summary: 'The offered asset does not implement EIP-3009.',
    remediation: [PAYEE_MISCONFIGURED],
  }),
  invalid_exact_evm_token_name_mismatch: () => ({
    summary: "The offer's token domain name does not match the token contract.",
    remediation: [PAYEE_MISCONFIGURED],
  }),
  invalid_exact_evm_token_version_mismatch: () => ({
    summary: "The offer's token domain version does not match the token contract.",
    remediation: [PAYEE_MISCONFIGURED],
  }),
  asset_not_deployed_contract: () => ({
    summary: 'The offered asset address has no code on this network.',
    remediation: [PAYEE_MISCONFIGURED],
  }),
  unexpected_verify_error: () => ({
    summary: 'The facilitator hit an internal error while verifying.',
    remediation: ['Retry shortly.'],
  }),
  unexpected_settle_error: () => ({
    summary: 'The facilitator hit an internal error while settling.',
    remediation: ['Run `agentpay reconcile` first: the transfer may still have landed. Then retry.'],
    commands: ['agentpay reconcile'],
  }),

  // ---- wallet-side outcomes ----
  unknown: () => ({
    summary: 'The payee answered without a usable PAYMENT-RESPONSE, so the wallet cannot tell whether it was charged.',
    remediation: ['Run `agentpay reconcile` before paying again, or the same call may be paid twice.'],
    commands: ['agentpay reconcile'],
  }),
  settlement_unavailable: () => ({
    summary: 'The payee could not reach its facilitator.',
    remediation: ['Retry shortly; nothing was charged.'],
  }),
};

export const HINT_REASONS = Object.keys(HINTS);

/** LLM-facing remediation for a refusal; unknown reasons get a generic hint. */
export function paymentModelContext(reason: string, detail?: Record<string, unknown>): PaymentModelContext {
  const hint = HINTS[reason]?.(detail) ?? {
    summary: `Payment refused: ${reason}.`,
    remediation: ['Read the error detail, fix the cause, and retry with a fresh authorization if appropriate.'],
  };
  return { protocol: 'x402', reason, ...hint };
}
