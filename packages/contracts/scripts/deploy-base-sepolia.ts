/**
 * Deploys AEP2DebitWallet to Base Sepolia (chain id 84532) against Circle's
 * testnet USDC. Writes packages/contracts/deployments/base-sepolia.json.
 *
 *   DEPLOYER_PK=0x... npm run deploy:base-sepolia
 *
 * Env: DEPLOYER_PK (required, funded with Base Sepolia ETH), RPC_URL (default
 *      https://sepolia.base.org), USDC_ADDRESS (default Circle's Base Sepolia
 *      USDC), WITHDRAW_DELAY seconds (default 86400).
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { deployDebitWallet, writeDeployment } from '../src/index.js';

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

async function main(): Promise<void> {
  const key = process.env.DEPLOYER_PK as Hex | undefined;
  if (!key) throw new Error('DEPLOYER_PK is required');
  const rpcUrl = process.env.RPC_URL ?? 'https://sepolia.base.org';
  const usdc = (process.env.USDC_ADDRESS ?? BASE_SEPOLIA_USDC) as Address;
  const withdrawDelay = Number(process.env.WITHDRAW_DELAY ?? 86_400);

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) throw new Error(`RPC is chain ${chainId}, expected ${baseSepolia.id}`);

  const wallet = await deployDebitWallet(walletClient, publicClient, { withdrawDelay });
  const block = await publicClient.getBlock();
  const path = writeDeployment('base-sepolia', {
    chainId,
    network: `eip155:${chainId}`,
    wallet,
    usdc,
    withdrawDelay,
    deployer: account.address,
    txHash: '0x' as Hex,
    blockNumber: Number(block.number),
    deployedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ chainId, wallet, usdc, withdrawDelay, wrote: path }, null, 2));
  console.log(`explorer: https://sepolia.basescan.org/address/${wallet}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
