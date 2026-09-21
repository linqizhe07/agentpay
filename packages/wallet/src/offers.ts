/**
 * Which x402 offers this wallet can honour, as a pure function: the wallet
 * uses it to pick from a 402's `accepts[]`, and a discovery client (the
 * CLI's `discover`) uses the same predicate over a catalogue so it lists
 * only what the wallet would actually pay. Keeping the two on one function
 * is the point: a catalogue row that passes here is one `pay` will not
 * refuse as `unsupported_offer`.
 */
import { isAddress } from 'viem';
import { X402_SCHEME, type Address, type AssetDomain, type PaymentRequirements } from '@agentpay/core';

/** Longest authorization validity the wallet signs by default (seconds): a payee asking for more is `timeout_too_long`. */
export const DEFAULT_MAX_AUTHORIZATION_VALIDITY = 300;

export interface PayableScope {
  /** CAIP-2 network the wallet pays on, e.g. `eip155:84532`. */
  network: string;
  /** The wallet's token (case-insensitive match). */
  token: Address | string;
  /** EIP-712 domain of that token; an offer under another name/version would sign the wrong typed data. */
  assetDomain: AssetDomain;
}

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * True when `o` is an exact/EIP-3009 offer on the wallet's network and token,
 * under the token domain the wallet knows, with a positive integer amount, a
 * real payee address and a positive integer timeout. `upto`, Permit2
 * (`assetTransferMethod: 'permit2'`), another chain, another token or another
 * domain are all false: the wallet registers only the exact EVM scheme.
 */
export function isPayableOffer(o: unknown, scope: PayableScope): o is PaymentRequirements {
  if (typeof o !== 'object' || o === null) return false;
  const x = o as Partial<PaymentRequirements>;
  const extra = (x.extra ?? undefined) as Record<string, unknown> | undefined;
  return (
    x.scheme === X402_SCHEME &&
    x.network === scope.network &&
    typeof x.asset === 'string' &&
    eqAddr(x.asset, scope.token) &&
    typeof x.amount === 'string' &&
    /^\d+$/.test(x.amount) &&
    BigInt(x.amount) > 0n &&
    typeof x.payTo === 'string' &&
    isAddress(x.payTo, { strict: false }) &&
    typeof x.maxTimeoutSeconds === 'number' &&
    Number.isInteger(x.maxTimeoutSeconds) &&
    x.maxTimeoutSeconds > 0 &&
    typeof extra === 'object' &&
    extra !== null &&
    extra.name === scope.assetDomain.name &&
    extra.version === scope.assetDomain.version &&
    (extra.assetTransferMethod === undefined || extra.assetTransferMethod === 'eip3009')
  );
}
