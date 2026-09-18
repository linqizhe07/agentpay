/**
 * End-to-end: runs the demo script as a child process (fresh hardhat node,
 * in-process settlement processor, express payee, agent wallet) and asserts
 * every scenario reported PASS. Needs free ports 8545 / 3001 / 4021.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Well inside the test timeout, so a hung demo is killed and its output shown instead of a bare "timed out". */
const DEMO_TIMEOUT_MS = 200_000;

function runDemo(args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['tsx', 'src/run-demo.ts', ...args], { cwd: DEMO_DIR, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      stderr += `\n[e2e] demo still running after ${DEMO_TIMEOUT_MS}ms; killing it\n`;
      child.kill('SIGKILL');
    }, DEMO_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe('demo end-to-end', () => {
  it('all seven scenarios pass', async () => {
    const { code, stdout, stderr } = await runDemo();
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stdout).toContain('ALL SCENARIO ASSERTIONS PASSED');
    expect(stdout).not.toContain('✗');
    for (const scenario of ['Scenario 1', 'Scenario 2', 'Scenario 3', 'Scenario 4', 'Scenario 5', 'Scenario 6', 'Scenario 7']) {
      expect(stdout).toContain(scenario);
    }
    // The headline claims of the protocol, as printed by the runner.
    expect(stdout).toContain('settlement is deferred');
    // Scenario 6 also sweeps the mandates left pending by earlier scenarios (24 in total).
    expect(stdout).toMatch(/one settleBatch tx .* settled (2\d|[3-9]\d) mandates, skipped 0/);
    expect(stdout).toContain('WithdrawalLocked');
  }, 240_000);
});
