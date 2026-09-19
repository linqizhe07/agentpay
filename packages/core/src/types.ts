export type Hex = `0x${string}`;
export type Address = `0x${string}`;

// The wire format is x402 V2's; these are the official types, re-exported so
// the other workspaces have one import for them.
export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettleResponse,
  SupportedKind,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';

/** The only x402 scheme this stack speaks: EIP-3009 `transferWithAuthorization`, one on-chain settlement per call. */
export const X402_SCHEME = 'exact' as const;

/** EIP-712 domain (name, version) of an EIP-3009 token; x402 carries it in `PaymentRequirements.extra`. */
export interface AssetDomain {
  name: string;
  version: string;
}

/** Remediation hints for LLM agents, attached to policy denials and to the 402 body. */
export interface PaymentModelContext {
  protocol: 'x402';
  reason: string;
  summary: string;
  remediation: string[];
  commands?: string[];
}

/** Minimal signer interface satisfied by viem local accounts. */
export interface TypedDataSigner {
  address: Address;
  signTypedData: (parameters: any) => Promise<Hex>;
}
