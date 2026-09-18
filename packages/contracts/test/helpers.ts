import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import {
  mandateDigest,
  randomNonce,
  resourceRef,
  signMandate,
  type Mandate,
  type MandateDomain,
} from '@agentpay/core';
import { AEP2_DEBIT_WALLET_ABI, MOCK_USDC_ABI, deployAll } from '../src/index.js';

export const RPC_URL = 'http://127.0.0.1:8546';
export const CHAIN_ID = 31337;

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

// Fast polling (node automines) and no transport retries: hardhat reports
// deterministic reverts with a retryable-looking JSON-RPC code, and viem's
// default backoff turns every expected revert into a ~3s stall.
const transport = http(RPC_URL, { retryCount: 0 });

export const publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
export const testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport, pollingInterval: 50 });

export function walletFor(account: PrivateKeyAccount) {
  return createWalletClient({ chain: hardhat, transport, account, pollingInterval: 50 });
}

export const wallets = {
  deployer: walletFor(accounts.deployer),
  payer: walletFor(accounts.payer),
  payee: walletFor(accounts.payee),
  sp: walletFor(accounts.sp),
  stranger: walletFor(accounts.stranger),
};

export const WITHDRAW_DELAY = 600;
export const RESOURCE = 'GET /predict';
export const AMOUNT = 50_000n; // $0.05

export interface Fixture {
  usdc: Address;
  wallet: Address;
}

/** Deploys MockUSDC + AEP2DebitWallet(WITHDRAW_DELAY) and mints $10,000 to payer and stranger. */
export async function deployFixture(): Promise<Fixture> {
  const { usdc, wallet } = await deployAll(wallets.deployer, publicClient, { withdrawDelay: WITHDRAW_DELAY });
  for (const to of [accounts.payer.address, accounts.stranger.address]) {
    const hash = await wallets.deployer.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [to, parseUnits('10000', 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  return { usdc, wallet };
}

export async function now(): Promise<number> {
  const block = await publicClient.getBlock();
  return Number(block.timestamp);
}

export async function timeTravel(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

export async function balanceOf(usdc: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [owner] });
}

export async function walletBalance(f: Fixture, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'balances',
    args: [owner, f.usdc],
  });
}

export async function debitable(f: Fixture, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'debitableBalance',
    args: [owner, f.usdc],
  });
}

export async function nonceUsed(f: Fixture, owner: Address, nonce: string): Promise<boolean> {
  return publicClient.readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'usedNonces',
    args: [owner, BigInt(nonce)],
  });
}

export function domainFor(f: Fixture): MandateDomain {
  return { chainId: CHAIN_ID, verifyingContract: f.wallet };
}

/** approve + deposit from `account`. */
export async function depositFor(f: Fixture, who: keyof typeof wallets, amount: bigint): Promise<void> {
  const w = wallets[who];
  const approve = await w.writeContract({
    address: f.usdc,
    abi: MOCK_USDC_ABI,
    functionName: 'approve',
    args: [f.wallet, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approve });
  const dep = await w.writeContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'deposit',
    args: [f.usdc, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: dep });
}

/** authorizeSP / revokeSP / cancelRevoke from `who`, mined; returns the receipt for event assertions. */
export async function setSpAuthorization(
  f: Fixture,
  who: keyof typeof wallets,
  functionName: 'authorizeSP' | 'revokeSP' | 'cancelRevoke',
  sp: Address,
) {
  const hash = await wallets[who].writeContract({ address: f.wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName, args: [sp] });
  return publicClient.waitForTransactionReceipt({ hash });
}

export async function authorizeSpFor(f: Fixture, who: keyof typeof wallets, sp: Address): Promise<void> {
  await setSpAuthorization(f, who, 'authorizeSP', sp);
}

export async function spAuthorized(f: Fixture, owner: Address, sp: Address): Promise<boolean> {
  return publicClient.readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'authorizedSP',
    args: [owner, sp],
  });
}

export async function authorizationOf(f: Fixture, owner: Address, sp: Address): Promise<{ enabled: boolean; revokeAt: number }> {
  const [enabled, revokeAt] = await publicClient.readContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'authorizationOf',
    args: [owner, sp],
  });
  return { enabled, revokeAt: Number(revokeAt) };
}

export async function makeMandate(f: Fixture, overrides: Partial<Mandate> = {}): Promise<Mandate> {
  const nowSec = await now();
  return {
    owner: accounts.payer.address,
    token: f.usdc,
    payee: accounts.payee.address,
    amount: AMOUNT.toString(),
    nonce: randomNonce(),
    deadline: nowSec + 3600,
    ref: resourceRef(RESOURCE),
    ...overrides,
  };
}

export interface SignedMandate {
  mandate: Mandate;
  sig: Hex;
  digest: Hex;
}

export async function signedMandate(
  f: Fixture,
  overrides: Partial<Mandate> = {},
  signer: PrivateKeyAccount = accounts.payer,
): Promise<SignedMandate> {
  const mandate = await makeMandate(f, overrides);
  const sig = await signMandate(signer, domainFor(f), mandate);
  return { mandate, sig, digest: mandateDigest(domainFor(f), mandate) };
}

/** Mandate struct in the shape viem expects for contract args. */
export function tuple(m: Mandate) {
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

export async function settleAs(f: Fixture, who: keyof typeof wallets, s: SignedMandate) {
  const hash = await wallets[who].writeContract({
    address: f.wallet,
    abi: AEP2_DEBIT_WALLET_ABI,
    functionName: 'settle',
    args: [tuple(s.mandate), s.sig],
  });
  return publicClient.waitForTransactionReceipt({ hash });
}
