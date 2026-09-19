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
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN, deployLocalFixture } from '../src/index.js';

export const RPC_URL = 'http://127.0.0.1:8546';
export const CHAIN_ID = 31337;

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
  facilitator: walletFor(accounts.facilitator),
  stranger: walletFor(accounts.stranger),
};

export const AMOUNT = 50_000n; // $0.05

export interface Fixture {
  usdc: Address;
}

/** Deploys MockUSDC (+ Multicall3) and mints $10,000 to payer and stranger. */
export async function deployFixture(): Promise<Fixture> {
  const { usdc } = await deployLocalFixture(wallets.deployer, publicClient, testClient);
  for (const to of [accounts.payer.address, accounts.stranger.address]) {
    const hash = await wallets.deployer.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [to, parseUnits('10000', 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  return { usdc };
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

// --------------------------------------------------------------- EIP-3009

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A payer → payee authorization valid for the next hour (chain time), unless overridden. */
export async function makeAuthorization(overrides: Partial<Authorization> = {}): Promise<Authorization> {
  const t = await now();
  return {
    from: accounts.payer.address,
    to: accounts.payee.address,
    value: AMOUNT,
    validAfter: 0n,
    validBefore: BigInt(t + 3600),
    nonce: randomNonce(),
    ...overrides,
  };
}

export async function signAuthorization(
  usdc: Address,
  auth: Authorization,
  signer: PrivateKeyAccount = accounts.payer,
): Promise<{ v: number; r: Hex; s: Hex; signature: Hex }> {
  const signature = await signer.signTypedData({
    domain: { ...MOCK_USDC_DOMAIN, chainId: CHAIN_ID, verifyingContract: usdc },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: auth,
  });
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return { v, r, s, signature };
}

/** Submits transferWithAuthorization from `who` (anyone may relay it) and returns the receipt. */
export async function transferWithAuthorization(
  usdc: Address,
  who: keyof typeof wallets,
  auth: Authorization,
  sig: { v: number; r: Hex; s: Hex },
) {
  const hash = await wallets[who].writeContract({
    address: usdc,
    abi: MOCK_USDC_ABI,
    functionName: 'transferWithAuthorization',
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s],
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

export async function authorizationState(usdc: Address, authorizer: Address, nonce: Hex): Promise<boolean> {
  return publicClient.readContract({
    address: usdc,
    abi: MOCK_USDC_ABI,
    functionName: 'authorizationState',
    args: [authorizer, nonce],
  });
}
