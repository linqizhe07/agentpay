import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.js';

const __dir = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the contracts workspace (where hardhat.config lives). */
export const CONTRACTS_DIR = resolve(__dir, '..', '..', 'contracts');

export interface ChainOptions {
  /** JSON-RPC port; default 8545. */
  port?: number;
  /** Working directory for `npx hardhat node`; default CONTRACTS_DIR. */
  cwd?: string;
  /** How long to wait for the RPC to come up; default 60s (first run compiles). */
  readyTimeoutMs?: number;
  /** Optional sink for the node's stdout/stderr lines. */
  onLine?: (line: string) => void;
}

export interface ChainHandle {
  rpcUrl: string;
  port: number;
  /** SIGTERM the node, escalating to SIGKILL after 5s. Idempotent. */
  stop(): Promise<void>;
}

/** True iff a JSON-RPC endpoint answers eth_chainId at the URL. */
export async function rpcAlive(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: unknown };
    return typeof json.result === 'string';
  } catch {
    return false;
  }
}

/** Polls until the RPC answers; throws after timeoutMs. */
export async function waitForRpc(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await rpcAlive(rpcUrl)) return;
    await sleep(150);
  }
  throw new Error(`RPC at ${rpcUrl} not ready after ${timeoutMs}ms`);
}

/**
 * Spawns `npx hardhat node --port <port>` with cwd = contracts workspace,
 * waits for RPC readiness, and returns a handle whose stop() kills it.
 * Refuses to start if something already answers on the port (a stale node
 * would carry stale state and make the demo lie).
 */
export async function startChain(opts: ChainOptions = {}): Promise<ChainHandle> {
  const port = opts.port ?? 8545;
  const cwd = opts.cwd ?? CONTRACTS_DIR;
  const rpcUrl = `http://127.0.0.1:${port}`;

  if (await rpcAlive(rpcUrl)) {
    throw new Error(
      `something already answers JSON-RPC on ${rpcUrl} — kill the stale node first; the demo needs a fresh chain`,
    );
  }

  const child: ChildProcess = spawn('npx', ['hardhat', 'node', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const tail: string[] = [];
  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
      opts.onLine?.(line);
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  let exitCode: number | null = null;
  const exitPromise = new Promise<void>((res) => {
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      res();
    });
  });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 60_000);
  for (;;) {
    if (exited) {
      throw new Error(
        `hardhat node exited early (code ${exitCode}).\n--- last output ---\n${tail.join('\n')}`,
      );
    }
    if (await rpcAlive(rpcUrl)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `hardhat node did not become ready within ${opts.readyTimeoutMs ?? 60_000}ms.\n--- last output ---\n${tail.join('\n')}`,
      );
    }
    await sleep(200);
  }

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    const escalate = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, 5_000);
    await exitPromise;
    clearTimeout(escalate);
  };

  return { rpcUrl, port, stop };
}
