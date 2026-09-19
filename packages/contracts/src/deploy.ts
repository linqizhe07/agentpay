import type { Address, Hex } from 'viem';
import { MOCK_USDC_ABI, MOCK_USDC_BYTECODE } from './abi.js';
import { MULTICALL3_ADDRESS, MULTICALL3_BYTECODE } from './multicall3.js';

// Structural client types: viem's PublicClient/WalletClient generics differ per
// chain (Base's OP-stack formatters vs hardhat), so accept anything with the
// methods we call rather than one specific instantiation.
export interface DeployWalletClient {
  deployContract: (args: { abi: any; bytecode: Hex; args?: any }) => Promise<Hex>;
}
export interface DeployPublicClient {
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ contractAddress?: Address | null }>;
}
/** The hardhat-mode test client: only `setCode` is used. */
export interface DeployTestClient {
  setCode: (args: { address: Address; bytecode: Hex }) => Promise<void>;
}

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

/**
 * Everything a local chain needs to behave like Base for the x402 stack:
 * MockUSDC (the EIP-3009 asset) plus Multicall3 at its canonical address
 * (installed with hardhat_setCode, so this only works against a Hardhat node).
 */
export async function deployLocalFixture(
  walletClient: DeployWalletClient,
  publicClient: DeployPublicClient,
  testClient: DeployTestClient,
): Promise<{ usdc: Address }> {
  const usdc = await deployMockUsdc(walletClient, publicClient);
  await testClient.setCode({ address: MULTICALL3_ADDRESS, bytecode: MULTICALL3_BYTECODE });
  return { usdc };
}
