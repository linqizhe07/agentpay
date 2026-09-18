import type { Address, Hex } from 'viem';
import {
  AEP2_DEBIT_WALLET_ABI,
  AEP2_DEBIT_WALLET_BYTECODE,
  MOCK_USDC_ABI,
  MOCK_USDC_BYTECODE,
} from './abi.js';

// Structural client types: viem's PublicClient/WalletClient generics differ per
// chain (Base's OP-stack formatters vs hardhat), so accept anything with the two
// methods we call rather than one specific instantiation.
export interface DeployWalletClient {
  deployContract: (args: { abi: any; bytecode: Hex; args?: any }) => Promise<Hex>;
}
export interface DeployPublicClient {
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ contractAddress?: Address | null }>;
}

/**
 * 6 hours: twice the SP's default settle window (10_800). The SP refuses to
 * start unless the wallet's withdrawDelay exceeds its window by
 * WITHDRAW_DELAY_MARGIN_SECONDS, so a wallet deployed with this default and an
 * SP started with its defaults fit together.
 */
export const DEFAULT_WITHDRAW_DELAY = 21_600;

async function deployed(publicClient: DeployPublicClient, hash: Hex, what: string): Promise<Address> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${what} deployment yielded no address`);
  return receipt.contractAddress;
}

/** Deploys the test-only MockUSDC (open mint). Never on a public network. */
export async function deployMockUsdc(
  walletClient: DeployWalletClient,
  publicClient: DeployPublicClient,
): Promise<Address> {
  const hash = await walletClient.deployContract({ abi: MOCK_USDC_ABI, bytecode: MOCK_USDC_BYTECODE });
  return deployed(publicClient, hash, 'MockUSDC');
}

export async function deployDebitWallet(
  walletClient: DeployWalletClient,
  publicClient: DeployPublicClient,
  opts: { withdrawDelay: number },
): Promise<Address> {
  const hash = await walletClient.deployContract({
    abi: AEP2_DEBIT_WALLET_ABI,
    bytecode: AEP2_DEBIT_WALLET_BYTECODE,
    args: [BigInt(opts.withdrawDelay)],
  });
  return deployed(publicClient, hash, 'AEP2DebitWallet');
}

/**
 * Deploys MockUSDC then AEP2DebitWallet and returns both addresses. The
 * walletClient's account pays gas (any funded dev account).
 */
export async function deployAll(
  walletClient: DeployWalletClient,
  publicClient: DeployPublicClient,
  opts: { withdrawDelay?: number } = {},
): Promise<{ usdc: Address; wallet: Address; withdrawDelay: number }> {
  const withdrawDelay = opts.withdrawDelay ?? DEFAULT_WITHDRAW_DELAY;
  const usdc = await deployMockUsdc(walletClient, publicClient);
  const wallet = await deployDebitWallet(walletClient, publicClient, { withdrawDelay });
  return { usdc, wallet, withdrawDelay };
}
