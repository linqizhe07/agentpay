import type { Server } from 'node:http';
import type { Express } from 'express';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  HEADER,
  decodeHeader,
  encodeHeader,
  mandateDigest,
  randomNonce,
  resourceRef,
  signMandate,
  type Hex,
  type Mandate,
  type MandateDomain,
  type MandatePayload,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type SettlementInfo,
} from '@agentpay/core';

// Hardhat's famous PUBLIC dev-mnemonic accounts ("test test ... junk") — never
// real funds. 0=deployer, 1=payer agent, 2=payee, 3=settlement processor, 4=stranger.
export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payee: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  sp: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;

export const accounts = {
  deployer: privateKeyToAccount(KEYS.deployer),
  payer: privateKeyToAccount(KEYS.payer),
  payee: privateKeyToAccount(KEYS.payee),
  sp: privateKeyToAccount(KEYS.sp),
  stranger: privateKeyToAccount(KEYS.stranger),
};

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Listens on an ephemeral loopback port. */
export async function listen(app: Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no ephemeral port');
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Fetches the bare 402 and returns its (first) offer from the PAYMENT-REQUIRED header. */
export async function getOffer(base: string, path: string, method = 'GET'): Promise<PaymentRequirements> {
  const res = await fetch(`${base}${path}`, { method });
  await res.arrayBuffer();
  if (res.status !== 402) throw new Error(`expected a 402 offer for ${method} ${path}, got ${res.status}`);
  const header = res.headers.get(HEADER.required);
  if (!header) throw new Error('402 without PAYMENT-REQUIRED header');
  return decodeHeader<PaymentRequiredBody>(header).accepts[0];
}

export interface Signed {
  mandate: Mandate;
  payerSig: Hex;
  digest: Hex;
  payload: MandatePayload;
}

/**
 * Signs a mandate for `offer` with hardhat key #1 (payer) unless another signer
 * is given. `overrides` are applied after the defaults (so owner can differ from
 * the signer to produce an invalid signature).
 */
export async function signFor(
  domain: MandateDomain,
  offer: PaymentRequirements,
  overrides: Partial<Mandate> = {},
  signer: PrivateKeyAccount = accounts.payer,
): Promise<Signed> {
  const mandate: Mandate = {
    owner: signer.address,
    token: offer.asset,
    payee: offer.payTo,
    amount: offer.amount,
    nonce: randomNonce(),
    deadline: nowSec() + offer.extra.settleWindowSeconds + 600,
    ref: resourceRef(offer.resource, offer.extra.quoteId),
    ...overrides,
  };
  const payerSig = await signMandate(signer, domain, mandate);
  return { mandate, payerSig, digest: mandateDigest(domain, mandate), payload: { mandate, payerSig } };
}

/** x402 V2 envelope for PAYMENT-SIGNATURE: echoes the offer the payer accepted. */
export function x402Header(offer: PaymentRequirements, payload: MandatePayload): string {
  const envelope: PaymentPayload = { x402Version: 2, accepted: offer, payload };
  return encodeHeader(envelope);
}

/** FluxA-style bare {mandate, payerSig} for X-Payment-Mandate. */
export function legacyHeader(payload: MandatePayload): string {
  return encodeHeader(payload);
}

export interface CallInit {
  method?: string;
  /** Value for PAYMENT-SIGNATURE (or X-Payment-Mandate when `legacy`). */
  header?: string;
  legacy?: boolean;
  /** JSON body. */
  body?: unknown;
  extraHeaders?: Record<string, string>;
}

export async function call(base: string, path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.extraHeaders ?? {}) };
  if (init.header !== undefined) headers[init.legacy ? HEADER.legacyMandate : HEADER.signature] = init.header;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export function readSettlement(res: Response): SettlementInfo {
  const header = res.headers.get(HEADER.response);
  if (!header) throw new Error('response carries no PAYMENT-RESPONSE header');
  return decodeHeader<SettlementInfo>(header);
}
