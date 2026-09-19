import { signSpReceipt, type Hex, type MandateDomain, type SpReceipt, type TypedDataSigner } from '@agentpay/core';

/**
 * The SP promises to settle by the earlier of the mandate's own deadline and the
 * end of its settlement window. Because every payer's withdrawDelay exceeds the
 * window (by the margin `assertStartup` enforces), a mandate enqueued at T is
 * always settleable before funds requested for withdrawal after T can leave the
 * wallet, or a revocation scheduled after T takes effect.
 */
export function enqueueDeadlineFor(mandateDeadline: number, now: number, settleWindowSeconds: number): number {
  return Math.min(mandateDeadline, now + settleWindowSeconds);
}

/** EIP-712 SPReceipt over (mandateDigest, enqueueDeadline), bound to the wallet deployment. */
export async function issueReceipt(
  account: TypedDataSigner,
  domain: MandateDomain,
  mandateDigest: Hex,
  enqueueDeadline: number,
): Promise<SpReceipt> {
  return signSpReceipt(account, domain, mandateDigest, enqueueDeadline);
}
