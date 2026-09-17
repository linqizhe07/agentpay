// Type-only express import: the middleware is a plain (req, res, next) handler
// and MUST NOT pull express in at runtime (it is a dev dependency only).
import type { Request } from 'express';
import type { Address, Hex, SettlementInfo, SpReceipt } from '@agentpay/core';

/**
 * Atomic per-mandate idempotency ledger keyed by the EIP-712 mandate digest:
 * one signed mandate buys exactly one delivery. `claim` must not await between
 * check and set (the in-memory store relies on Node's single-threaded loop).
 */
export interface IdempotencyStore {
  /** Claims a digest; false when it is already claimed. */
  claim(digest: Hex): boolean;
  /** Frees a claim after a downstream failure so the same mandate can be retried. */
  release(digest: Hex): void;
  has(digest: Hex): boolean;
}

/**
 * Structural stand-in for a viem PublicClient: only `readContract` is used, and
 * viem's client generics differ per chain, so accept anything with that method.
 */
export interface ReadContractClient {
  readContract: (args: any) => Promise<any>;
}

/** The Settlement Processor this resource routes mandates to (advertised in the offer). */
export interface SpEndpoint {
  /** Base URL, e.g. 'http://127.0.0.1:3001'. */
  url: string;
  /** The SP's signing address; enqueue receipts must be signed by it. */
  address: Address;
  /** The SP settles within this many seconds of enqueueing; mandates must outlive it. */
  settleWindowSeconds: number;
  /** HTTP timeout for SP calls. Default 5000. */
  timeoutMs?: number;
}

export interface MandatePaywallOptions {
  /** Human price, e.g. '$0.001' (USDC, 6 decimals; sub-cent allowed). */
  price: string;
  /** CAIP-2 network id: 'eip155:31337' | 'eip155:84532'. */
  network: string;
  /** Token contract the mandate must name. */
  asset: Address;
  /** Payee address (receives settlement payouts). */
  payTo: Address;
  /** AEP2DebitWallet contract (EIP-712 verifyingContract of mandates and receipts). */
  wallet: Address;
  sp: SpEndpoint;
  /** Resource identifier bound into mandates. Default `${req.method} ${req.path}`. */
  resourceOf?: (req: Request) => string;
  /** Optional per-request quote id; echoed as extra.quoteId and bound into the mandate ref. */
  quoteIdOf?: (req: Request) => string | undefined;
  /**
   * Pre-check debitableBalance / usedNonces on-chain before enqueueing.
   * Default: network === 'eip155:31337' && (publicClient || rpcUrl) given.
   */
  verifyOnChain?: boolean;
  /** One of publicClient / rpcUrl is required when verifyOnChain is on. */
  publicClient?: ReadContractClient;
  rpcUrl?: string;
  /** Default: a fresh InMemoryIdempotencyStore per middleware. */
  idempotencyStore?: IdempotencyStore;
  /** Add a FluxA-style `payment` field to JSON bodies. Default false. */
  includeBodyPaymentField?: boolean;
  /** Attach payment_model_context hints to refusals. Default true. */
  includeHints?: boolean;
  /** Mandates whose deadline is within this many seconds are refused as expired. Default 30. */
  deadlineMarginSeconds?: number;
  /** Injectable clock (unix seconds). */
  now?: () => number;
  /** Injectable fetch for SP calls. */
  fetch?: typeof fetch;
  /** Called once per accepted mandate, right before the route handler runs. */
  onEnqueued?: (info: SettlementInfo, req: Request) => void;
}

/** What `includeBodyPaymentField` adds to JSON response bodies. */
export interface PaymentBodyField {
  status: 'enqueued';
  mandateDigest: Hex;
  spReceipt: SpReceipt;
}
