import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';
import {
  createPublicClient,
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
import { AEP2_DEBIT_WALLET_ABI, MOCK_USDC_ABI } from '@agentpay/contracts';
import {
  mandateDigest,
  mandateToTuple,
  randomNonce,
  resourceRef,
  signMandate,
  type Mandate,
  type MandateDomain,
} from '@agentpay/core';
import { createSP, type SPConfig, type SPHandle } from '../src/index.js';

// Hardhat's PUBLIC dev-mnemonic accounts — never real funds.
// 0 deployer, 1 payer, 2 payee, 3 settlement processor, 4 stranger.
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
  wallet: Address;
  withdrawDelay: number;
}

/** Deployed addresses, checksummed (the SP reports every address in EIP-55 form). */
export function fixture(): Fixture {
  return {
    rpcUrl: inject('rpcUrl'),
    chainId: inject('chainId'),
    usdc: getAddress(inject('usdc')),
    wallet: getAddress(inject('wallet')),
    withdrawDelay: inject('withdrawDelay'),
  };
}

export const USDC = (n: string): bigint => {
  const [whole, frac = ''] = n.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
};

export const RESOURCE = 'GET /predict';
export const AMOUNT = 50_000n; // $0.05

const transport = () => http(fixture().rpcUrl, { retryCount: 0 });

export const publicClient = () => createPublicClient({ chain: hardhat, transport: transport(), pollingInterval: 50 });

export function walletFor(account: Signer) {
  return createWalletClient({ chain: hardhat, transport: transport(), account, pollingInterval: 50 });
}

export function domain(): MandateDomain {
  const f = fixture();
  return { chainId: f.chainId, verifyingContract: f.wallet };
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

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

/** approve + deposit from `account`. */
export async function deposit(account: Signer, amount: bigint): Promise<void> {
  const f = fixture();
  const w = walletFor(account);
  await mined(
    await w.writeContract({ address: f.usdc, abi: MOCK_USDC_ABI, functionName: 'approve', args: [f.wallet, amount] }),
  );
  await mined(
    await w.writeContract({ address: f.wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName: 'deposit', args: [f.usdc, amount] }),
  );
}

export async function authorize(account: Signer, sp: Address, enabled = true): Promise<void> {
  const f = fixture();
  await mined(
    await walletFor(account).writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'authorizeSP',
      args: [sp, enabled],
    }),
  );
}

/** mint + deposit + authorizeSP: a payer ready to be settled by `sp`. */
export async function fund(account: Signer, amount: bigint, sp: Address): Promise<void> {
  await mint(account.address, amount);
  await deposit(account, amount);
  await authorize(account, sp);
}

export async function walletBalance(owner: Address): Promise<bigint> {
  const f = fixture();
  return publicClient().readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'balances',
    args: [owner, f.usdc],
  });
}

export async function debitable(owner: Address): Promise<bigint> {
  const f = fixture();
  return publicClient().readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'debitableBalance',
    args: [owner, f.usdc],
  });
}

export async function usdcBalance(who: Address): Promise<bigint> {
  const f = fixture();
  return publicClient().readContract({ address: f.usdc, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [who] });
}

export async function nonceUsed(owner: Address, nonce: string): Promise<boolean> {
  const f = fixture();
  return publicClient().readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'usedNonces',
    args: [owner, BigInt(nonce)],
  });
}

export interface Signed {
  mandate: Mandate;
  payerSig: Hex;
  digest: Hex;
}

export function mandateFor(over: Partial<Mandate> = {}, owner: Address = accounts.payer.address): Mandate {
  const f = fixture();
  return {
    owner,
    token: f.usdc,
    payee: accounts.payee.address,
    amount: AMOUNT.toString(),
    nonce: randomNonce(),
    deadline: nowSec() + 3600,
    ref: resourceRef(RESOURCE),
    ...over,
  };
}

/** A mandate signed by `signer` (owner defaults to the signer's address). */
export async function signed(over: Partial<Mandate> = {}, signer: Signer = accounts.payer): Promise<Signed> {
  const mandate = mandateFor(over, over.owner ?? signer.address);
  const payerSig = await signMandate(signer, domain(), mandate);
  return { mandate, payerSig, digest: mandateDigest(domain(), mandate) };
}

/** Out-of-band settle(m, sig) as `as` (default: the SP account itself). */
export async function settleDirect(s: Pick<Signed, 'mandate' | 'payerSig'>, as: Signer = accounts.sp): Promise<TransactionReceipt> {
  const f = fixture();
  return mined(
    await walletFor(as).writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settle',
      args: [mandateToTuple(s.mandate), s.payerSig],
    }),
  );
}

export const SETTLE_WINDOW = 600;

export function mkSP(over: Partial<SPConfig> = {}): SPHandle {
  const f = fixture();
  return createSP({
    rpcUrl: f.rpcUrl,
    chainId: f.chainId,
    key: KEYS.sp,
    wallet: f.wallet,
    tokens: [f.usdc],
    port: 0,
    batchIntervalMs: 0,
    settleWindowSeconds: SETTLE_WINDOW,
    pollingIntervalMs: 50,
    log: () => {},
    ...over,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Reply<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

export async function post(url: string, body: unknown, raw = false): Promise<Reply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

export async function get(url: string, method = 'GET'): Promise<Reply> {
  const res = await fetch(url, { method });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

export function enqueue(sp: SPHandle, s: Pick<Signed, 'mandate' | 'payerSig'>, extra: Record<string, unknown> = {}): Promise<Reply> {
  return post(`${sp.url}/enqueue`, { mandate: s.mandate, payerSig: s.payerSig, ...extra });
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000, everyMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export function tmpStorePath(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'agentpay-sp-')), `${name}.jsonl`);
}

export interface RpcProxy {
  url: string;
  dead: boolean;
  close(): Promise<void>;
}

/**
 * A JSON-RPC pass-through the test can kill: while `dead`, every request gets a
 * 503, which is what a vanished RPC provider looks like to the SP.
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
