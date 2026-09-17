// vitest globalSetup for the chain suite: spawns a dedicated hardhat node on
// port 8549, deploys MockUSDC + AEP2DebitWallet, mints USDC to the payer and
// provide()s the addresses to chain.test.ts. Skipped entirely (nothing
// spawned, nothing provided) when AGENTPAY_SKIP_CHAIN_TESTS=1; the offline
// suite never touches a chain.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';
import { createPublicClient, createWalletClient, http, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { MOCK_USDC_ABI, deployAll } from '@agentpay/contracts';

export const CHAIN_RPC_URL = 'http://127.0.0.1:8549';
export const CHAIN_WITHDRAW_DELAY = 600;

export interface ChainFixture {
  rpcUrl: string;
  usdc: Address;
  wallet: Address;
  withdrawDelay: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    agentpayChain: ChainFixture;
  }
}

const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts');
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYER_ADDRESS = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d').address;

let child: ChildProcess | undefined;

async function rpcAlive(): Promise<boolean> {
  try {
    const res = await fetch(CHAIN_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: string };
    return typeof body.result === 'string';
  } catch {
    return false;
  }
}

async function ensureNode(): Promise<void> {
  if (await rpcAlive()) return; // reuse a dev-started node
  child = spawn('npx', ['hardhat', 'node', '--port', '8549'], {
    cwd: CONTRACTS_DIR,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await rpcAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('hardhat node did not become ready on :8549 within 60s');
}

async function deployFixture(): Promise<ChainFixture> {
  const transport = http(CHAIN_RPC_URL, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
  const deployer = createWalletClient({
    chain: hardhat,
    transport,
    account: privateKeyToAccount(DEPLOYER_KEY),
    pollingInterval: 50,
  });
  const { usdc, wallet } = await deployAll(deployer, publicClient, { withdrawDelay: CHAIN_WITHDRAW_DELAY });
  const hash = await deployer.writeContract({
    address: usdc,
    abi: MOCK_USDC_ABI,
    functionName: 'mint',
    args: [PAYER_ADDRESS, parseUnits('10000', 6)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { rpcUrl: CHAIN_RPC_URL, usdc, wallet, withdrawDelay: CHAIN_WITHDRAW_DELAY };
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  if (process.env.AGENTPAY_SKIP_CHAIN_TESTS === '1') return;
  await ensureNode();
  provide('agentpayChain', await deployFixture());
}

export async function teardown(): Promise<void> {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // whole process group (npx -> node)
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
