import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inject } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { EIP3009_ABI, randomBytes32 } from '@agentpay/core';
import { createFacilitator, type FacilitatorConfig, type FacilitatorHandle } from '../src/index.js';

// Hardhat's PUBLIC dev-mnemonic accounts — never real funds.
// 0 deployer, 1 payer, 2 payee, 3 facilitator, 4 stranger.
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

export type Signer = LocalAccount;

const MNEMONIC = 'test test test test test test test test test test test junk';

/** Hardhat dev account #index (5..19 are unused by the named roles; all hold 10000 ETH). */
export function extraAccount(index: number): Signer {
  return mnemonicToAccount(MNEMONIC, { addressIndex: index });
}

export interface Fixture {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
}

/** Deployed addresses, checksummed. */
export function fixture(): Fixture {
  return { rpcUrl: inject('rpcUrl'), chainId: inject('chainId'), usdc: getAddress(inject('usdc')) };
}

export const USDC = (n: string): bigint => {
  const [whole, frac = ''] = n.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
};

export const AMOUNT = 50_000n; // $0.05
export const MAX_TIMEOUT_SECONDS = 60;

const transport = () => http(fixture().rpcUrl, { retryCount: 0 });

export const publicClient = () => createPublicClient({ chain: hardhat, transport: transport(), pollingInterval: 50 });
export const testClient = () => createTestClient({ chain: hardhat, mode: 'hardhat', transport: transport(), pollingInterval: 50 });

export function walletFor(account: Signer) {
  return createWalletClient({ chain: hardhat, transport: transport(), account, pollingInterval: 50 });
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function chainNow(): Promise<number> {
  return Number((await publicClient().getBlock()).timestamp);
}

async function mined(hash: Hex): Promise<TransactionReceipt> {
  return publicClient().waitForTransactionReceipt({ hash });
}

export async function mint(to: Address, amount: bigint): Promise<void> {
  const f = fixture();
  await mined(
    await walletFor(accounts.deployer).writeContract({
      address: f.usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [to, amount],
    }),
  );
}

export async function usdcBalance(who: Address): Promise<bigint> {
  return publicClient().readContract({ address: fixture().usdc, abi: EIP3009_ABI, functionName: 'balanceOf', args: [who] });
}

export async function authorizationState(authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient().readContract({
    address: fixture().usdc,
    abi: EIP3009_ABI,
    functionName: 'authorizationState',
    args: [authorizer, nonce],
  });
}

// ------------------------------------------------------------ x402 payloads

/** What a payee would advertise for one paid call. */
export function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  const f = fixture();
  return {
    scheme: 'exact',
    network: `eip155:${f.chainId}`,
    asset: f.usdc,
    amount: AMOUNT.toString(),
    payTo: accounts.payee.address,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...MOCK_USDC_DOMAIN, assetTransferMethod: 'eip3009' },
    ...over,
  };
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface SignedPayment {
  requirements: PaymentRequirements;
  authorization: Authorization;
  signature: Hex;
  payload: PaymentPayload;
}

/**
 * Builds and signs an EIP-3009 authorization for `req` the way the official
 * client does (validAfter 0, validBefore now + maxTimeoutSeconds, random nonce),
 * with `over` applied to the authorization and `signer` producing the signature.
 */
export async function signedPayment(
  req: PaymentRequirements = requirements(),
  over: Partial<Authorization> = {},
  signer: Signer = accounts.payer,
): Promise<SignedPayment> {
  const f = fixture();
  const authorization: Authorization = {
    from: signer.address,
    to: req.payTo as Address,
    value: req.amount,
    validAfter: '0',
    validBefore: String(nowSec() + req.maxTimeoutSeconds),
    nonce: randomBytes32(),
    ...over,
  };
  const signature = await signer.signTypedData({
    domain: { name: String(req.extra.name), version: String(req.extra.version), chainId: f.chainId, verifyingContract: req.asset as Address },
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
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: req,
    payload: { signature, authorization },
  };
  return { requirements: req, authorization, signature, payload };
}

// ------------------------------------------------------------ facilitator

export function mkFacilitator(over: Partial<FacilitatorConfig> = {}): FacilitatorHandle {
  const f = fixture();
  return createFacilitator({
    rpcUrl: f.rpcUrl,
    chainId: f.chainId,
    key: KEYS.facilitator,
    tokens: [f.usdc],
    assetDomain: { ...MOCK_USDC_DOMAIN },
    port: 0,
    pollingIntervalMs: 50,
    receiptTimeoutMs: 10_000,
    log: () => {},
    ...over,
  });
}

export interface Reply<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

export async function post(url: string, body: unknown, opts: { raw?: boolean; headers?: Record<string, string> } = {}): Promise<Reply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.raw ? (body as string) : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

export async function get(url: string, method = 'GET'): Promise<Reply> {
  const res = await fetch(url, { method });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

export function facilitatorBody(s: SignedPayment, requirementsOverride?: PaymentRequirements) {
  return { x402Version: 2, paymentPayload: s.payload, paymentRequirements: requirementsOverride ?? s.requirements };
}

export function verify(fac: FacilitatorHandle, s: SignedPayment, requirementsOverride?: PaymentRequirements): Promise<Reply> {
  return post(`${fac.url}/verify`, facilitatorBody(s, requirementsOverride));
}

export function settle(fac: FacilitatorHandle, s: SignedPayment, requirementsOverride?: PaymentRequirements): Promise<Reply> {
  return post(`${fac.url}/settle`, facilitatorBody(s, requirementsOverride));
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000, everyMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export interface RpcProxy {
  url: string;
  dead: boolean;
  close(): Promise<void>;
}

/**
 * A JSON-RPC pass-through the test can kill: while `dead`, every request gets a
 * 503, which is what a vanished RPC provider looks like to the facilitator.
 */
export async function rpcProxy(target: string): Promise<RpcProxy> {
  const state = { dead: false };
  const server = createServer((req, res) => {
    if (state.dead) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('rpc proxy is dead');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: Buffer.concat(chunks),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(text);
      } catch (err) {
        res.writeHead(502);
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get dead() {
      return state.dead;
    },
    set dead(v: boolean) {
      state.dead = v;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
