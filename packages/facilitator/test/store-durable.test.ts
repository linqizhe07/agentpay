/**
 * Pins the half of the store's durability contract that store.test.ts cannot
 * see: an enq event is fsynced before insert() returns (README: "every receipt
 * it signs is fsynced to that file first"), an upd event deliberately is not
 * (start-up reconcile recovers a lost one from the chain), and the memory-only
 * store never touches the filesystem. node:fs is partially mocked so the fsync
 * calls themselves are observable; a plain appendFileSync would keep every
 * other suite green.
 */
import { fsyncSync, openSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@agentpay/core';
import { JsonlStore, type QueueRecord } from '../src/index.js';
import { tmpStorePath } from './helpers.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync) };
});

const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const WALLET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
let counter = 0;

function rec(): QueueRecord {
  counter += 1;
  const digest = `0x${counter.toString(16).padStart(64, '0')}` as Hex;
  return {
    mandateDigest: digest,
    chainId: 31337,
    wallet: WALLET,
    mandate: { owner: OWNER, token: TOKEN, payee: WALLET, amount: '1000', nonce: String(counter), deadline: 1_800_000_000, ref: `0x${'11'.repeat(32)}` as Hex },
    payerSig: `0x${'22'.repeat(65)}` as Hex,
    receipt: { sp: WALLET, mandateDigest: digest, enqueueDeadline: 1_800_000_000, spEnqueueSig: `0x${'33'.repeat(65)}` as Hex },
    status: 'pending',
    attempts: 0,
    enqueuedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  };
}

/** The paths whose data was fsynced: each fsyncSync(fd) attributed to the latest openSync that returned that fd before it. */
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

describe('JsonlStore durability', () => {
  beforeEach(() => {
    vi.mocked(openSync).mockClear();
    vi.mocked(fsyncSync).mockClear();
  });

  it('fsyncs the store file once per insert(), and not for update()', () => {
    const path = tmpStorePath('fsync');
    const store = new JsonlStore(path);
    const a = rec();
    store.insert(a);
    expect(fsyncedPaths()).toEqual([path]);

    store.update(a.mandateDigest, { status: 'settling' }, 1);
    expect(fsyncedPaths()).toEqual([path]); // upd is not fsynced by design

    store.insert(rec());
    expect(fsyncedPaths()).toEqual([path, path]);
  });

  it('the memory-only store never opens or fsyncs anything', () => {
    const store = new JsonlStore();
    const a = rec();
    store.insert(a);
    store.update(a.mandateDigest, { status: 'settled' }, 1);
    expect(openSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(store.path).toBeUndefined();
  });
});
