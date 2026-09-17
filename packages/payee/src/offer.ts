import { AEP2_SCHEME, parsePrice, type Aep2Extra, type PaymentRequirements } from '@agentpay/core';
import type { MandatePaywallOptions } from './types.js';

/** How long the payer has to present a mandate after receiving the offer. */
export const OFFER_MAX_TIMEOUT_SECONDS = 60;

/** The x402-shaped 'aep2' offer this middleware advertises for `resource`. */
export function buildOffer(
  options: MandatePaywallOptions,
  resource: string,
  quoteId?: string,
): PaymentRequirements {
  const extra: Aep2Extra = {
    wallet: options.wallet,
    sp: options.sp.url,
    spAddress: options.sp.address,
    settleWindowSeconds: options.sp.settleWindowSeconds,
  };
  if (quoteId !== undefined) extra.quoteId = quoteId;
  return {
    scheme: AEP2_SCHEME,
    network: options.network,
    amount: parsePrice(options.price).toString(),
    asset: options.asset,
    payTo: options.payTo,
    resource,
    maxTimeoutSeconds: OFFER_MAX_TIMEOUT_SECONDS,
    extra,
  };
}
