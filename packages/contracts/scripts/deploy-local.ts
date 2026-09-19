/**
 * Deploys MockUSDC (+ Multicall3 at its canonical address) to a local Hardhat
 * node and mints test USDC to the demo accounts. Writes
 * packages/contracts/deployments/localhost.json.
 *
 *   (cd packages/contracts && npx hardhat node --port 8545)   # in another shell
 *   npm run deploy:local
 *
 * Env: RPC_URL (default http://127.0.0.1:8545), DEPLOYER_PK (default Hardhat #0).
 * The facilitator (Hardhat #3 in the docs) needs ETH for gas, which every
 * Hardhat dev account already has; payers only need USDC.
 */
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN, deployLocalFixture, writeDeployment } from '../src/index.js';

// Hardhat's famous PUBLIC dev keys — never real funds.
const HARDHAT_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FUNDED: Address[] = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1 payer agent
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2 payee
];

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const key = (process.env.DEPLOYER_PK ?? HARDHAT_KEY_0) as Hex;

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: hardhat, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: hardhat, transport: http(rpcUrl) });
  const testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();

  const { usdc } = await deployLocalFixture(walletClient, publicClient, testClient);
  for (const to of FUNDED) {
    const hash = await walletClient.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [to, parseUnits('10000', 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const block = await publicClient.getBlock();
  const path = writeDeployment('localhost', {
    chainId,
    network: `eip155:${chainId}`,
    usdc,
    usdcDomain: { ...MOCK_USDC_DOMAIN },
    deployer: account.address,
    blockNumber: Number(block.number),
    deployedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ chainId, usdc, usdcDomain: MOCK_USDC_DOMAIN, minted: FUNDED, wrote: path }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
