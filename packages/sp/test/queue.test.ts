import { describe, expect, it } from 'vitest';
import type { Hex } from '@agentpay/core';
import { JsonlStore, Queue, type QueueRecord } from '../src/index.js';

const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PAYEE = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const WALLET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

let counter = 0;

function rec(over: Partial<QueueRecord['mandate']> = {}): QueueRecord {
  counter += 1;
  const digest = `0x${counter.toString(16).padStart(64, '0')}` as Hex;
  return {
    mandateDigest: digest,
    chainId: 31337,
    wallet: WALLET,
    mandate: {
      owner: OWNER,
      token: TOKEN,
      payee: PAYEE,
      amount: '300000',
      nonce: String(counter),
      deadline: 1_800_000_000,
      ref: `0x${'11'.repeat(32)}` as Hex,
      ...over,
    },
    payerSig: `0x${'22'.repeat(65)}` as Hex,
    receipt: { sp: PAYEE, mandateDigest: digest, enqueueDeadline: 1_800_000_000, spEnqueueSig: `0x${'33'.repeat(65)}` as Hex },
    status: 'pending',
    attempts: 0,
    enqueuedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  };
}

/**
 * The HTTP-level races in enqueue.test.ts cannot tell a synchronous claim from
 * one that yields a microtask (each request's continuation is its own I/O
 * task, so the microtask queue drains between them). Starting every claim
 * from the same microtask checkpoint can: an `await` anywhere between the
 * funds check and the insert interleaves the six and admits more than three.
 */
describe('Queue.claim', () => {
  it('is atomic across claims started in one tick: 6 x 300000 against 1000000 admits exactly 3', async () => {
    const store = new JsonlStore();
    const queue = new Queue(store);
    const records = Array.from({ length: 6 }, () => rec());
    const results = await Promise.all(records.map(async (r) => queue.claim(r, 1_000_000n)));
    const admitted = results.filter((r) => r.ok && r.created);
    const refused = results.filter((r) => !r.ok);
    expect(admitted).toHaveLength(3);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: 'insufficient_balance', reserved: 900_000n });
    expect(store.reserved(OWNER, TOKEN)).toBe(900_000n);
    expect(store.size).toBe(3);
  });

  it('answers repeated claims of one digest with the original record and created:false', async () => {
    const store = new JsonlStore();
    const queue = new Queue(store);
    const r = rec();
    const results = await Promise.all([r, r, r].map(async (x) => queue.claim({ ...x }, 1_000_000n)));
    expect(results.filter((x) => x.ok && x.created)).toHaveLength(1);
    expect(results.filter((x) => x.ok && !x.created)).toHaveLength(2);
    for (const x of results) if (x.ok) expect(x.rec).toBe(store.get(r.mandateDigest));
    expect(store.size).toBe(1);
    expect(store.reserved(OWNER, TOKEN)).toBe(300_000n);
  });

  it('refuses a second mandate on a nonce already bound to another digest', () => {
    const queue = new Queue(new JsonlStore());
    const first = rec({ nonce: '7' });
    expect(queue.claim(first, 1_000_000n)).toMatchObject({ ok: true, created: true });
    expect(queue.claim(rec({ nonce: '7' }), 1_000_000n)).toEqual({ ok: false, code: 'nonce_used', digest: first.mandateDigest });
  });
});
