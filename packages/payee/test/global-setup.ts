/**
 * Payee chain-test fixture: spawns `npx hardhat node --port 8548` (reusing a
 * node that already answers there), deploys MockUSDC + AEP2DebitWallet from
 * the committed bytecode (no compile step), mints USDC to the payer, deposits
 * $100 into the wallet and authorizes SP #3. Addresses are `provide`d to the
 * workers; the offline suites never touch them.
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
// Hardhat public dev keys: #0 deployer, #1 payer, #3 settlement processor.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SP_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

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
    provide('wallet', ZERO);
    provide('rpcUrl', RPC_URL);
    return async () => {};
  }

  const contractsDir = fileURLToPath(new URL('../../../contracts', import.meta.url));
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
    const { createPublicClient, createWalletClient, http, parseUnits } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { hardhat } = await import('viem/chains');

    const transport = http(RPC_URL, { retryCount: 0 });
    const pub = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: hardhat, transport, pollingInterval: 50 });
    const payerAccount = privateKeyToAccount(PAYER_KEY);
    const payer = createWalletClient({ account: payerAccount, chain: hardhat, transport, pollingInterval: 50 });

    const { usdc, wallet } = await contracts.deployAll(deployer, pub, { withdrawDelay: 600 });
    const wait = (hash: `0x${string}`) => pub.waitForTransactionReceipt({ hash });

    await wait(
      await deployer.writeContract({
        address: usdc,
        abi: contracts.MOCK_USDC_ABI,
        functionName: 'mint',
        args: [payerAccount.address, parseUnits('10000', 6)],
      }),
    );
    const deposit = parseUnits('100', 6);
    await wait(
      await payer.writeContract({ address: usdc, abi: contracts.MOCK_USDC_ABI, functionName: 'approve', args: [wallet, deposit] }),
    );
    await wait(
      await payer.writeContract({
        address: wallet,
        abi: contracts.AEP2_DEBIT_WALLET_ABI,
        functionName: 'deposit',
        args: [usdc, deposit],
      }),
    );
    await wait(
      await payer.writeContract({
        address: wallet,
        abi: contracts.AEP2_DEBIT_WALLET_ABI,
        functionName: 'authorizeSP',
        args: [SP_ADDRESS, true],
      }),
    );

    provide('skipReason', '');
    provide('usdc', usdc);
    provide('wallet', wallet);
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
