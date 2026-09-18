import type { PayeeReason, PolicyReason, SpErrorCode } from './errors.js';
import { AEP2_SCHEME, type PaymentModelContext } from './types.js';

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
  'sp_not_trusted',
  'unsupported_offer',
] as const satisfies readonly PolicyReason[];

export const PAYEE_REASONS = [
  'invalid_payment',
  'offer_mismatch',
  'invalid_payee',
  'invalid_token',
  'invalid_amount',
  'mandate_expired',
  'mandate_deadline_too_short',
  'invalid_ref',
  'invalid_signature',
  'replay',
  'insufficient_balance',
  'nonce_used',
  'chain_unavailable',
  'settlement_unavailable',
  'invalid_sp_receipt',
] as const satisfies readonly PayeeReason[];

export const SP_ERROR_CODES = [
  'invalid_body',
  'unsupported_chain',
  'unsupported_token',
  'bad_params',
  'deadline_too_soon',
  'deadline_too_far',
  'invalid_signature',
  'mandate_terminal',
  'nonce_used',
  'sp_not_authorized',
  'sp_revocation_pending',
  'rpc_error',
  'insufficient_balance',
] as const satisfies readonly SpErrorCode[];

interface Hint {
  summary: string;
  remediation: string[];
  commands?: string[];
}

const fmt = (detail: Record<string, unknown> | undefined, key: string, fallback = '?'): string => {
  const v = detail?.[key];
  return v === undefined || v === null ? fallback : String(v);
};

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
    remediation: ['Request a fresh intent mandate (or, for a one-time mandate, sign a new one with a later deadline).'],
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
  sp_not_trusted: (d) => ({
    summary: `The offer names settlement processor ${fmt(d, 'spAddress')}, which this wallet does not trust.`,
    remediation: ['Ask the user to add the SP to the trusted list (AGENTPAY_SP) or use another service.'],
  }),
  unsupported_offer: () => ({
    summary: 'The 402 offer has no aep2 option for this wallet\'s network, token and debit-wallet contract.',
    remediation: ['This service cannot be paid with this wallet; report the offer to the user.'],
  }),

  // ---- payee-side ----
  invalid_payment: () => ({
    summary: 'The payment header could not be decoded.',
    remediation: ['Re-send with a base64 JSON PAYMENT-SIGNATURE header produced by the wallet SDK.'],
  }),
  offer_mismatch: () => ({
    summary: 'The echoed offer does not match what this resource currently charges.',
    remediation: ['Fetch a fresh 402 offer and sign a mandate against it (prices or terms changed).'],
  }),
  invalid_payee: () => ({
    summary: 'mandate.payee is not this resource\'s payTo address.',
    remediation: ['Sign the mandate with payee = offer.payTo.'],
  }),
  invalid_token: () => ({
    summary: 'mandate.token is not the asset this resource accepts.',
    remediation: ['Sign the mandate with token = offer.asset.'],
  }),
  invalid_amount: () => ({
    summary: 'mandate.amount is below the price.',
    remediation: ['Sign the mandate with amount >= offer.amount.'],
  }),
  mandate_deadline_too_short: (d) => ({
    summary: `mandate.deadline must be at least ${fmt(d, 'settleWindowSeconds')}s in the future so the settlement processor can settle.`,
    remediation: ['Sign with deadline = now + settleWindowSeconds + request timeout.'],
  }),
  invalid_ref: () => ({
    summary: 'mandate.ref does not commit to this resource (and quote id, if any).',
    remediation: ['Set ref = keccak256("METHOD /path") or keccak256("METHOD /path#quoteId") from the offer.'],
  }),
  invalid_signature: () => ({
    summary: 'The mandate signature does not recover to mandate.owner.',
    remediation: ['Sign the exact mandate fields with the owner key under the AEP2DebitWallet EIP-712 domain.'],
  }),
  replay: () => ({
    summary: 'This exact mandate was already presented; a mandate pays for one delivery.',
    remediation: ['Sign a new mandate (new nonce) for another call.'],
  }),
  insufficient_balance: (d) => ({
    summary: `Debitable balance ${fmt(d, 'debitable')} is below the amount ${fmt(d, 'amount')} plus pending settlements.`,
    remediation: ['Deposit more USDC into the debit wallet (`agentpay deposit <usd>`) or cancel a pending withdrawal.'],
    commands: ['agentpay balance', 'agentpay deposit <usd>'],
  }),
  nonce_used: () => ({
    summary: 'This mandate nonce was already settled or enqueued.',
    remediation: ['Sign a new mandate with a fresh nonce.'],
  }),
  chain_unavailable: () => ({
    summary: 'The payee could not reach the chain to pre-check the mandate.',
    remediation: ['Retry shortly; the signed mandate is still valid until its deadline.'],
  }),
  settlement_unavailable: (d) => ({
    summary: `The settlement processor refused or was unreachable: ${fmt(d, 'spReason', 'unknown')}.`,
    remediation: [
      'If the reason is insufficient_balance, sp_not_authorized or sp_revocation_pending, fix the wallet state (deposit, or `agentpay sp-authorize <sp>`).',
      'Otherwise retry shortly with a new mandate.',
    ],
    commands: ['agentpay balance', 'agentpay sp-authorize <sp>'],
  }),
  invalid_sp_receipt: () => ({
    summary: 'The settlement processor returned a receipt that does not verify.',
    remediation: ['Retry; if it persists the service is misconfigured. Nothing has been settled.'],
  }),

  // ---- settlement processor ----
  invalid_body: () => ({
    summary: 'POST /enqueue body is not {mandate, payerSig}.',
    remediation: ['Send JSON {mandate:{owner,token,payee,amount,nonce,deadline,ref}, payerSig}.'],
  }),
  unsupported_chain: () => ({
    summary: 'The settlement processor serves a different chain.',
    remediation: ['Use the SP advertised in the 402 offer for this network.'],
  }),
  unsupported_token: () => ({
    summary: 'The settlement processor does not settle this token.',
    remediation: ['Check GET /supported on the SP and pay with a listed token.'],
  }),
  bad_params: () => ({
    summary: 'The mandate has a zero amount or zero payee.',
    remediation: ['Sign a mandate with amount > 0 and a real payee address.'],
  }),
  deadline_too_soon: (d) => ({
    summary: `mandate.deadline leaves less than ${fmt(d, 'minDeadlineMarginSeconds')}s for settlement.`,
    remediation: ['Sign with a later deadline (now + settleWindowSeconds + margin).'],
  }),
  deadline_too_far: (d) => ({
    summary: `mandate.deadline is more than ${fmt(d, 'maxDeadlineHorizonSeconds')}s away.`,
    remediation: ['Sign with a shorter validity; long-lived mandates are refused to bound the queue.'],
  }),
  mandate_terminal: (d) => ({
    summary: `This mandate already reached a terminal state: ${fmt(d, 'previous')}.`,
    remediation: ['Sign a new mandate; the old one cannot be re-enqueued.'],
  }),
  sp_not_authorized: (d) => ({
    summary: `The payer has not authorized settlement processor ${fmt(d, 'sp')} on the debit wallet.`,
    remediation: ['Authorize it once from the payer account: `agentpay sp-authorize <sp>`.'],
    commands: ['agentpay sp-authorize <sp>'],
  }),
  sp_revocation_pending: (d) => ({
    summary: `The payer is revoking settlement processor ${fmt(d, 'sp')} at ${fmt(d, 'revokeAt')} (unix seconds), before this mandate could be settled (${fmt(d, 'enqueueDeadline')}).`,
    remediation: [
      'Do not retry: the processor refuses new mandates until the payer re-authorizes it (`agentpay sp-authorize <sp>`, which also cancels the revocation).',
    ],
    commands: ['agentpay sp-authorize <sp>'],
  }),
  rpc_error: () => ({
    summary: 'The settlement processor could not reach the chain.',
    remediation: ['Retry shortly.'],
  }),
};

export const HINT_REASONS = Object.keys(HINTS);

/** LLM-facing remediation for a refusal; unknown reasons get a generic hint. */
export function paymentModelContext(reason: string, detail?: Record<string, unknown>): PaymentModelContext {
  const hint = HINTS[reason]?.(detail) ?? {
    summary: `Payment refused: ${reason}.`,
    remediation: ['Read the error detail, fix the cause, and retry with a fresh mandate if appropriate.'],
  };
  return { protocol: AEP2_SCHEME, reason, ...hint };
}
