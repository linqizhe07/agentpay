import type { Server } from 'node:http';
import type { Express } from 'express';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { randomBytes32, type Hex } from '@agentpay/core';

// Hardhat's famous PUBLIC dev-mnemonic accounts ("test test ... junk") — never
// real funds. 0=deployer, 1=payer agent, 2=payee, 3=facilitator, 4=stranger.
export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payee: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  facilitator: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;

export const accounts = {
  deployer: privateKeyToAccount(KEYS.deployer),
  payer: privateKeyToAccount(KEYS.payer),
  payee: privateKeyToAccount(KEYS.payee),
  facilitator: privateKeyToAccount(KEYS.facilitator),
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

/** GET the resource without paying and decode the PAYMENT-REQUIRED header. */
export async function getOffer(url: string, init: RequestInit = {}): Promise<{ res: Response; required: PaymentRequired; body: any }> {
  const res = await fetch(url, init);
  const header = res.headers.get('PAYMENT-REQUIRED');
  if (!header) throw new Error(`no PAYMENT-REQUIRED header (status ${res.status})`);
  const text = await res.text();
  return { res, required: decodePaymentRequiredHeader(header), body: text ? JSON.parse(text) : undefined };
}

export interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** Signs an EIP-3009 authorization for `req` the way the official client does, with `over` applied first. */
export async function signFor(
  req: PaymentRequirements,
  over: Partial<Authorization> = {},
  signer: PrivateKeyAccount = accounts.payer,
): Promise<{ authorization: Authorization; signature: Hex }> {
  const authorization: Authorization = {
    from: signer.address,
    to: req.payTo as Hex,
    value: req.amount,
    validAfter: '0',
    validBefore: String(nowSec() + req.maxTimeoutSeconds),
    nonce: randomBytes32(),
    ...over,
  };
  const signature = await signer.signTypedData({
    domain: {
      name: String(req.extra.name),
      version: String(req.extra.version),
      chainId: Number(req.network.split(':')[1]),
      verifyingContract: req.asset as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { authorization, signature };
}

/** A complete PAYMENT-SIGNATURE payload for the first accept of `required`. */
export async function paymentFor(
  required: PaymentRequired,
  over: Partial<Authorization> = {},
  signer: PrivateKeyAccount = accounts.payer,
  acceptedOverride?: Partial<PaymentRequirements>,
): Promise<PaymentPayload> {
  const accepted = { ...required.accepts[0]!, ...(acceptedOverride ?? {}) };
  const { authorization, signature } = await signFor(required.accepts[0]!, over, signer);
  return { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization } };
}

export function paymentHeaders(payload: PaymentPayload): Record<string, string> {
  return { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) };
}

/** Calls the resource with a payment attached. */
export async function pay(url: string, payload: PaymentPayload, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...paymentHeaders(payload) } });
}

export function readSettlement(res: Response): SettleResponse | undefined {
  const header = res.headers.get('PAYMENT-RESPONSE');
  return header ? decodePaymentResponseHeader(header) : undefined;
}

/** The `error` a 402 carries in its PAYMENT-REQUIRED header. */
export function refusalReason(res: Response): string | undefined {
  const header = res.headers.get('PAYMENT-REQUIRED');
  return header ? decodePaymentRequiredHeader(header).error : undefined;
}
