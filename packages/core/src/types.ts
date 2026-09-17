export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** The x402 scheme name under which AEP2 mandates travel. */
export const AEP2_SCHEME = 'aep2' as const;

/**
 * One-time payment mandate, signed by the payer (EIP-712) and settled later by
 * an authorized Settlement Processor against the payer's AEP2DebitWallet balance.
 * `amount` and `nonce` are decimal strings of uint256 values (JSON-safe, and the
 * same encoding FluxA's reference implementation uses); `deadline` is unix seconds.
 */
export interface Mandate {
  owner: Address;
  token: Address;
  payee: Address;
  amount: string;
  nonce: string;
  deadline: number;
  /** keccak256 of the resource binding (see resourceRef). Opaque to the contract. */
  ref: Hex;
}

/** What the payer transmits: the mandate plus its EIP-712 signature. Also the body of the legacy X-Payment-Mandate header. */
export interface MandatePayload {
  mandate: Mandate;
  payerSig: Hex;
}

/** AEP2-specific offer terms carried in the x402 offer's `extra`. */
export interface Aep2Extra {
  /** AEP2DebitWallet contract the mandate is settled against (EIP-712 verifyingContract). */
  wallet: Address;
  /** Settlement Processor base URL (the payee forwards mandates here). */
  sp: string;
  /** Settlement Processor signing address (signs enqueue receipts). */
  spAddress: Address;
  /** The SP promises to settle within this many seconds of enqueueing. */
  settleWindowSeconds: number;
  /** Optional per-quote binding; when present it is part of the mandate `ref`. */
  quoteId?: string;
}

/** One entry of the 402 offer's `accepts` array (x402 V2-shaped, scheme 'aep2'). */
export interface PaymentRequirements {
  scheme: typeof AEP2_SCHEME;
  /** CAIP-2 network id, e.g. 'eip155:31337'. */
  network: string;
  /** Atomic token units as a decimal string (USDC: 6 decimals, '1000' = $0.001). */
  amount: string;
  /** Token contract address. */
  asset: Address;
  /** Payee address (receives the settlement payout). */
  payTo: Address;
  /** 'METHOD /path' identifier of the paid resource. */
  resource: string;
  description?: string;
  maxTimeoutSeconds: number;
  extra: Aep2Extra;
}

/** Remediation hints for LLM agents, attached to policy denials and 402/403 responses. */
export interface PaymentModelContext {
  protocol: typeof AEP2_SCHEME;
  reason: string;
  summary: string;
  remediation: string[];
  commands?: string[];
}

export interface PaymentRequiredBody {
  x402Version: 2;
  error?: string;
  accepts: PaymentRequirements[];
  payment_model_context?: PaymentModelContext;
}

export interface PaymentPayload {
  x402Version: 2;
  /** Echo of the chosen offer so the payee can check both sides agree on terms. */
  accepted: PaymentRequirements;
  payload: MandatePayload;
}

/** Settlement Processor's signed promise to settle a mandate by `enqueueDeadline`. */
export interface SpReceipt {
  sp: Address;
  mandateDigest: Hex;
  /** Unix seconds. */
  enqueueDeadline: number;
  spEnqueueSig: Hex;
}

/**
 * Contents of the PAYMENT-RESPONSE header. Keeps x402's `success/network/payer/
 * transaction` field names so stock x402 readers can parse it; `transaction` is
 * empty because settlement is deferred.
 */
export interface SettlementInfo {
  success: true;
  scheme: typeof AEP2_SCHEME;
  network: string;
  payer: Address;
  transaction: '';
  status: 'enqueued';
  mandateDigest: Hex;
  spReceipt: SpReceipt;
}

/** Minimal signer interface satisfied by viem local accounts. */
export interface TypedDataSigner {
  address: Address;
  signTypedData: (parameters: any) => Promise<Hex>;
}

/** EIP-712 domain parameters that vary per deployment. */
export interface MandateDomain {
  chainId: number;
  /** The AEP2DebitWallet contract address. */
  verifyingContract: Address;
}
