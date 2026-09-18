// vitest globalSetup: spawns a dedicated hardhat node on port 8547 (cwd =
// contracts/, so its hardhat.config.cjs applies), deploys MockUSDC +
// AEP2DebitWallet(withdrawDelay 600) from the committed bytecode, mints test
// USDC to the payer and stranger accounts and provides the addresses to the
// test workers. A node already answering on the port is reused and left alone.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { MOCK_USDC_ABI, deployAll } from '@agentpay/contracts';

const RPC_PORT = 8547;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');
const WITHDRAW_DELAY = 600;

// Hardhat's PUBLIC dev-mnemonic accounts — never real funds.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const STRANGER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';

let child: ChildProcess | undefined;

async function rpcAlive(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  if (!(await rpcAlive())) {
    child = spawn('npx', ['hardhat', 'node', '--port', String(RPC_PORT)], {
      cwd: CONTRACTS_DIR,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await rpcAlive()) {
        ready = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(250);
    }
    if (!ready) {
      kill();
      throw new Error(`sp tests: hardhat node did not become ready on :${RPC_PORT}`);
    }
  }

  try {
    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const transport = http(RPC_URL, { retryCount: 0 });
    const publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
    const walletClient = createWalletClient({ chain: hardhat, transport, account: deployer, pollingInterval: 50 });
    const { usdc, wallet } = await deployAll(walletClient, publicClient, { withdrawDelay: WITHDRAW_DELAY });
    for (const to of [PAYER, STRANGER] as const) {
      const hash = await walletClient.writeContract({
        address: usdc,
        abi: MOCK_USDC_ABI,
        functionName: 'mint',
        args: [to, parseUnits('10000', 6)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    provide('rpcUrl', RPC_URL);
    provide('chainId', hardhat.id);
    provide('usdc', usdc);
    provide('wallet', wallet);
    provide('withdrawDelay', WITHDRAW_DELAY);
  } catch (err) {
    kill();
    throw new Error(`sp tests: deploying contracts failed: ${(err as Error).message}`);
  }

  return async () => {
    kill();
  };
}

function kill(): void {
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
  child = undefined;
}
