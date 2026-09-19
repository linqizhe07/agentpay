/**
 * Payee chain-test fixture: spawns `npx hardhat node --port 8548` (reusing a
 * node that already answers there), deploys MockUSDC + Multicall3 from the
 * committed bytecode (no compile step) and mints USDC to the payer. Addresses
 * are `provide`d to the workers; the offline suites never touch them.
 *
 * Any environment failure THROWS. The only sanctioned skip is the explicit
 * opt-out AGENTPAY_SKIP_CHAIN_TESTS=1 (chain.test.ts then self-skips).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GlobalSetupContext } from 'vitest/node';

const RPC_PORT = 8548;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
// Hardhat public dev keys: #0 deployer, #1 payer.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const PAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const json = (await res.json()) as { result?: string };
    return typeof json.result === 'string';
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // whole process group (npx -> node hardhat)
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  if (process.env.AGENTPAY_SKIP_CHAIN_TESTS === '1') {
    provide('skipReason', 'AGENTPAY_SKIP_CHAIN_TESTS=1');
    provide('usdc', ZERO);
    provide('rpcUrl', RPC_URL);
    return async () => {};
  }

  const contractsDir = fileURLToPath(new URL('../../contracts', import.meta.url));
  let child: ChildProcess | undefined;

  if (!(await rpcUp())) {
    child = spawn('npx', ['hardhat', 'node', '--port', String(RPC_PORT)], {
      cwd: contractsDir,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (await rpcUp()) {
        ready = true;
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(500);
    }
    if (!ready) {
      killTree(child);
      throw new Error(`payee tests: hardhat node did not become ready on :${RPC_PORT}`);
    }
  }

  try {
    const contracts = await import('@agentpay/contracts');
    const { createPublicClient, createTestClient, createWalletClient, http, parseUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { hardhat } = await import('viem/chains');

    const transport = http(RPC_URL, { retryCount: 0 });
    const pub = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: hardhat, transport, pollingInterval: 50 });
    const testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport, pollingInterval: 50 });

    const { usdc } = await contracts.deployLocalFixture(deployer, pub, testClient);
    await pub.waitForTransactionReceipt({
      hash: await deployer.writeContract({
        address: usdc,
        abi: contracts.MOCK_USDC_ABI,
        functionName: 'mint',
        args: [PAYER, parseUnits('10000', 6)],
      }),
    });

    provide('skipReason', '');
    provide('usdc', usdc);
    provide('rpcUrl', RPC_URL);
  } catch (err) {
    killTree(child);
    throw new Error(`payee tests: deploying the fixture failed: ${(err as Error).message}`);
  }

  return async () => {
    killTree(child);
    if (child) await sleep(200);
  };
}
