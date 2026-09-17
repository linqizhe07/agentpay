import { hashTypedData, isAddress, keccak256, recoverTypedDataAddress, stringToBytes } from 'viem';
import { WireError } from './errors.js';
import type { Address, Hex, Mandate, MandateDomain, TypedDataSigner } from './types.js';

export const WALLET_DOMAIN = { name: 'AEP2DebitWallet', version: '1' } as const;

/** Must match AEP2DebitWallet.MANDATE_TYPEHASH field for field. */
export const MANDATE_TYPES = {
  Mandate: [
    { name: 'owner', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'ref', type: 'bytes32' },
  ],
} as const;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export function mandateDomain(d: MandateDomain) {
  return {
    name: WALLET_DOMAIN.name,
    version: WALLET_DOMAIN.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

/** The mandate as viem wants it for typed data and for contract call args. */
export function mandateToTuple(m: Mandate) {
  return {
    owner: m.owner,
    token: m.token,
    payee: m.payee,
    amount: BigInt(m.amount),
    nonce: BigInt(m.nonce),
    deadline: BigInt(m.deadline),
    ref: m.ref,
  };
}

export function buildMandateTypedData(d: MandateDomain, m: Mandate) {
  return {
    domain: mandateDomain(d),
    types: MANDATE_TYPES,
    primaryType: 'Mandate' as const,
    message: mandateToTuple(m),
  };
}

/** EIP-712 digest; byte-matches AEP2DebitWallet.mandateDigest(m). */
export function mandateDigest(d: MandateDomain, m: Mandate): Hex {
  return hashTypedData(buildMandateTypedData(d, m));
}

export async function signMandate(account: TypedDataSigner, d: MandateDomain, m: Mandate): Promise<Hex> {
  return account.signTypedData(buildMandateTypedData(d, m));
}

/** secp256k1 group order / 2: the low-s bound that OpenZeppelin's ECDSA enforces on-chain. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Off-chain verifiers must accept exactly the signatures the contract accepts.
 * viem recovers high-s and v∈{0,1} encodings happily, but AEP2DebitWallet
 * (OpenZeppelin ECDSA) rejects them — a payer could otherwise present a
 * malleated copy of its own signature, get served, and never be debited.
 * Throws WireError for anything but a canonical 65-byte (r, s, v) signature.
 */
export function assertCanonicalSignature(signature: unknown): asserts signature is Hex {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new WireError('signature must be 65 bytes of hex (r, s, v)');
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new WireError(`signature v must be 27 or 28, got ${v}`);
  if (s > SECP256K1_HALF_N) throw new WireError('signature is not low-s (malleable encoding)');
}

/** Recovers the signer of a canonical signature; throws WireError on malformed or malleable ones. */
export async function recoverMandateSigner(d: MandateDomain, m: Mandate, signature: Hex): Promise<Address> {
  assertCanonicalSignature(signature);
  return recoverTypedDataAddress({ ...buildMandateTypedData(d, m), signature });
}

/** Random 256-bit nonce as a decimal string (payer-chosen; parallel mandates never collide). */
export function randomNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString();
}

/**
 * The resource binding committed into a mandate: keccak256 of 'METHOD /path'
 * or, when the offer carries a quote id, of 'METHOD /path#<quoteId>'.
 */
export function resourceRef(resource: string, quoteId?: string): Hex {
  return keccak256(stringToBytes(quoteId ? `${resource}#${quoteId}` : resource));
}

function isDecimalUint(value: unknown, max: bigint): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= max;
}

/** Structural validation of an untrusted mandate object; throws WireError. */
export function assertMandateShape(x: unknown): asserts x is Mandate {
  if (typeof x !== 'object' || x === null) throw new WireError('mandate is not an object');
  const m = x as Record<string, unknown>;
  for (const field of ['owner', 'token', 'payee'] as const) {
    if (typeof m[field] !== 'string' || !isAddress(m[field] as string, { strict: false })) {
      throw new WireError(`mandate.${field} is not an address`);
    }
  }
  if (!isDecimalUint(m.amount, MAX_UINT256)) throw new WireError('mandate.amount is not a uint256 decimal string');
  if (!isDecimalUint(m.nonce, MAX_UINT256)) throw new WireError('mandate.nonce is not a uint256 decimal string');
  if (
    typeof m.deadline !== 'number' ||
    !Number.isInteger(m.deadline) ||
    m.deadline < 0 ||
    BigInt(m.deadline) > MAX_UINT64
  ) {
    throw new WireError('mandate.deadline is not a uint64 integer');
  }
  if (typeof m.ref !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.ref)) {
    throw new WireError('mandate.ref is not a 32-byte hex string');
  }
}

export function isHexSignature(x: unknown): x is Hex {
  return typeof x === 'string' && /^0x[0-9a-fA-F]{130}$/.test(x);
}
