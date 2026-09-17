import { recoverTypedDataAddress } from 'viem';
import type { Address, Hex, MandateDomain, SpReceipt, TypedDataSigner } from './types.js';

export const SP_DOMAIN = { name: 'AEP2SettlementProcessor', version: '1' } as const;

export const SP_RECEIPT_TYPES = {
  SPReceipt: [
    { name: 'mandateDigest', type: 'bytes32' },
    { name: 'enqueueDeadline', type: 'uint64' },
  ],
} as const;

/** Receipts are bound to the wallet deployment they promise to settle against. */
export function spReceiptDomain(d: MandateDomain) {
  return {
    name: SP_DOMAIN.name,
    version: SP_DOMAIN.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

export function buildSpReceiptTypedData(
  d: MandateDomain,
  r: Pick<SpReceipt, 'mandateDigest' | 'enqueueDeadline'>,
) {
  return {
    domain: spReceiptDomain(d),
    types: SP_RECEIPT_TYPES,
    primaryType: 'SPReceipt' as const,
    message: { mandateDigest: r.mandateDigest, enqueueDeadline: BigInt(r.enqueueDeadline) },
  };
}

export async function signSpReceipt(
  account: TypedDataSigner,
  d: MandateDomain,
  mandateDigest: Hex,
  enqueueDeadline: number,
): Promise<SpReceipt> {
  const spEnqueueSig = await account.signTypedData(
    buildSpReceiptTypedData(d, { mandateDigest, enqueueDeadline }),
  );
  return { sp: account.address, mandateDigest, enqueueDeadline, spEnqueueSig };
}

export async function recoverSpReceiptSigner(d: MandateDomain, r: SpReceipt): Promise<Address> {
  return recoverTypedDataAddress({ ...buildSpReceiptTypedData(d, r), signature: r.spEnqueueSig });
}

export type SpReceiptProblem =
  | 'malformed'
  | 'bad_signature'
  | 'sp_mismatch'
  | 'digest_mismatch'
  | 'deadline_past'
  | 'deadline_too_far'
  | 'deadline_after_mandate';

export interface VerifySpReceiptOptions {
  domain: MandateDomain;
  /** The SP address the offer advertised / the payee configured. */
  expectedSp?: Address;
  /** The digest of the mandate this receipt must cover. */
  mandateDigest?: Hex;
  /** The SP may not promise to settle after the mandate itself expires. */
  mandateDeadline?: number;
  /** Unix seconds. */
  now: number;
  /** Reject promises further out than the advertised settle window (plus skew). */
  maxWindowSeconds?: number;
}

function eqAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function verifySpReceipt(
  r: SpReceipt,
  o: VerifySpReceiptOptions,
): Promise<{ ok: true } | { ok: false; reason: SpReceiptProblem }> {
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof r.sp !== 'string' ||
    typeof r.mandateDigest !== 'string' ||
    typeof r.enqueueDeadline !== 'number' ||
    !Number.isInteger(r.enqueueDeadline) ||
    typeof r.spEnqueueSig !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  let signer: Address;
  try {
    signer = await recoverSpReceiptSigner(o.domain, r);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!eqAddr(signer, r.sp)) return { ok: false, reason: 'bad_signature' };
  if (o.expectedSp && !eqAddr(r.sp, o.expectedSp)) return { ok: false, reason: 'sp_mismatch' };
  if (o.mandateDigest && r.mandateDigest.toLowerCase() !== o.mandateDigest.toLowerCase()) {
    return { ok: false, reason: 'digest_mismatch' };
  }
  if (r.enqueueDeadline < o.now) return { ok: false, reason: 'deadline_past' };
  if (o.maxWindowSeconds !== undefined && r.enqueueDeadline > o.now + o.maxWindowSeconds) {
    return { ok: false, reason: 'deadline_too_far' };
  }
  if (o.mandateDeadline !== undefined && r.enqueueDeadline > o.mandateDeadline) {
    return { ok: false, reason: 'deadline_after_mandate' };
  }
  return { ok: true };
}
