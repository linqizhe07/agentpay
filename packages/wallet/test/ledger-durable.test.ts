/**
 * Pins the durability mechanics the README and report promise for ledger.jsonl:
 * every append is fsynced, and updateStatus() goes write-tmp -> fsync -> rename
 * (never an in-place rewrite). wallet.test.ts only observes the end state, which
 * an in-place writeFileSync would also produce; here node:fs is partially mocked
 * so the sequence itself is visible.
 */
import { fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@agentpay/core';
import { Ledger, type LedgerEntry } from '../src/index.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});

const root = mkdtempSync(join(tmpdir(), 'agentpay-ledger-durable-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADDR = ('0x' + '11'.repeat(20)) as `0x${string}`;

function entry(nonce: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  const n = ('0x' + nonce.repeat(32)) as Hex;
  return {
    v: 2,
    kind: 'payment',
    timestamp: 1,
    url: 'http://x/y',
    host: 'x',
    resource: 'GET /y',
    network: 'eip155:31337',
    asset: ADDR,
    amount: '5',
    payer: ADDR,
    payee: ADDR,
    intentMandateId: 'im_1',
    nonce: n,
    validBefore: 2,
    authorization: { from: ADDR, to: ADDR, value: '5', validAfter: '0', validBefore: '2', nonce: n },
    signature: '0x' as Hex,
    httpStatus: 200,
    status: 'unknown',
    ...over,
  };
}

/**
 * The paths whose data was fsynced, in call order: each fsyncSync(fd) is
 * attributed to the most recent openSync that returned that fd (fds are reused
 * after close, so the order of calls matters, not the fd number alone).
 */
function fsyncedPaths(): string[] {
  const opens = vi.mocked(openSync).mock;
  return vi.mocked(fsyncSync).mock.calls.map((call, i) => {
    const fd = call[0];
    const at = vi.mocked(fsyncSync).mock.invocationCallOrder[i];
    let path: string | undefined;
    for (let j = 0; j < opens.calls.length; j++) {
      if (opens.results[j].value === fd && opens.invocationCallOrder[j] < at) path = String(opens.calls[j][0]);
    }
    return path ?? `<fd ${fd}>`;
  });
}

describe('Ledger durability', () => {
  beforeEach(() => {
    vi.mocked(openSync).mockClear();
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();
  });

  it('append() fsyncs the ledger file itself before returning', () => {
    const path = join(root, 'append', 'ledger.jsonl');
    new Ledger(path).append(entry('ab'));
    expect(fsyncedPaths()).toContain(path);
  });

  it('updateStatus() writes and fsyncs a temp file, then renames it over the ledger', () => {
    const path = join(root, 'rewrite', 'ledger.jsonl');
    const ledger = new Ledger(path);
    const a = entry('ab');
    ledger.append(a);
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();

    ledger.updateStatus(a.nonce, 'settled');
    expect(renameSync).toHaveBeenCalledTimes(1);
    const [tmp, target] = vi.mocked(renameSync).mock.calls[0];
    expect(target).toBe(path);
    expect(String(tmp)).toMatch(/ledger\.jsonl\.\d+\.\d+\.tmp$/);
    // the data fsync targets the temp file, and it happens before the rename
    expect(fsyncedPaths()).toContain(String(tmp));
    const fsyncAt = vi.mocked(fsyncSync).mock.invocationCallOrder[fsyncedPaths().indexOf(String(tmp))];
    expect(fsyncAt).toBeLessThan(vi.mocked(renameSync).mock.invocationCallOrder[0]);
    expect(ledger.read().map((e) => e.status)).toEqual(['settled']);
  });

  it('a rename that fails leaves the ledger byte-for-byte as it was, no temp file behind, and surfaces the error', () => {
    const dir = join(root, 'rename-fails');
    const path = join(dir, 'ledger.jsonl');
    const ledger = new Ledger(path);
    const a = entry('ab');
    ledger.append(a);
    const before = readFileSync(path, 'utf8');

    let tmpContent: string | undefined;
    vi.mocked(renameSync).mockImplementationOnce((src) => {
      tmpContent = readFileSync(src, 'utf8'); // the temp file is complete when the rename is attempted
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => ledger.updateStatus(a.nonce, 'settled')).toThrow(/EIO/);

    expect(readFileSync(path, 'utf8')).toBe(before); // an in-place rewrite would already show 'settled'
    expect(tmpContent).toContain('"status":"settled"');
    expect(readdirSync(dir)).toEqual(['ledger.jsonl']);
    expect(ledger.read().map((e) => e.status)).toEqual(['unknown']);
  });
});
