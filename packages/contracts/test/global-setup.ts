// vitest globalSetup: spawns a dedicated hardhat node on port 8546 for the test
// run and tears it down afterwards. If something already answers on the port
// (e.g. a dev-started node), it is reused and left running.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_URL = 'http://127.0.0.1:8546';

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

export async function setup(): Promise<void> {
  if (await rpcAlive()) return; // reuse an already-running node

  child = spawn('npx', ['hardhat', 'node', '--port', '8546'], {
    cwd: WORKSPACE,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await rpcAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('hardhat node did not become ready on :8546 within 60s');
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
