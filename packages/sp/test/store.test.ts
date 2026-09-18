import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex } from '@agentpay/core';
import { JsonlStore, type QueueRecord, type RecordStatus } from '../src/index.js';
import { tmpStorePath } from './helpers.js';

const OWNER_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OWNER_B = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const WALLET = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

let counter = 0;

function rec(over: Partial<Omit<QueueRecord, 'mandate'>> & { mandate?: Partial<QueueRecord['mandate']> } = {}): QueueRecord {
  counter += 1;
  const digest = `0x${counter.toString(16).padStart(64, '0')}` as Hex;
  const { mandate: mandateOver, ...rest } = over;
  return {
    mandateDigest: digest,
    chainId: 31337,
    wallet: WALLET,
    mandate: {
      owner: OWNER_A,
      token: TOKEN,
      payee: OWNER_B,
      amount: '1000',
      nonce: String(counter),
      deadline: 1_800_000_000,
      ref: `0x${'11'.repeat(32)}` as Hex,
      ...mandateOver,
    },
    payerSig: `0x${'22'.repeat(65)}` as Hex,
    receipt: { sp: OWNER_B, mandateDigest: digest, enqueueDeadline: 1_800_000_000, spEnqueueSig: `0x${'33'.repeat(65)}` as Hex },
    status: 'pending',
    attempts: 0,
    enqueuedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...rest,
  };
}

describe('JsonlStore', () => {
  it('memory store: insert, update, lookups, counts', () => {
    const store = new JsonlStore();
    const a = rec();
    store.insert(a);
    expect(store.size).toBe(1);
    expect(store.get(a.mandateDigest)).toBe(a);
    expect(store.get(a.mandateDigest.toUpperCase().replace('0X', '0x'))).toBe(a);
    expect(store.digestForNonce(OWNER_A.toLowerCase(), a.mandate.nonce)).toBe(a.mandateDigest);
    expect(store.digestForNonce(OWNER_B, a.mandate.nonce)).toBeUndefined();
    expect(() => store.insert(a)).toThrow(/duplicate/);
    expect(() => store.update(`0x${'ff'.repeat(32)}`, { status: 'settled' }, 1)).toThrow(/unknown/);

    const updated = store.update(a.mandateDigest, { status: 'settled', txHash: `0x${'aa'.repeat(32)}` }, 1_700_000_100);
    expect(updated.status).toBe('settled');
    expect(updated.txHash).toBe(`0x${'aa'.repeat(32)}`);
    expect(updated.updatedAt).toBe(1_700_000_100);
    expect(store.counts()).toEqual({ pending: 0, settling: 0, settled: 1, failed: 0, expired: 0 });
    expect(store.byStatus('settled')).toEqual([a]);
  });

  it('reserved sums pending and settling per (owner, token) and releases on terminal states', () => {
    const store = new JsonlStore();
    const a = rec({ mandate: { amount: '600000' } });
    const b = rec({ mandate: { amount: '250000' } });
    const other = rec({ mandate: { owner: OWNER_B, amount: '999' } });
    store.insert(a);
    store.insert(b);
    store.insert(other);
    expect(store.reserved(OWNER_A, TOKEN)).toBe(850_000n);
    expect(store.reserved(OWNER_A.toLowerCase(), TOKEN.toLowerCase())).toBe(850_000n);
    expect(store.reserved(OWNER_B, TOKEN)).toBe(999n);
    expect(store.reserved(OWNER_A, WALLET)).toBe(0n);
    expect(store.unsettledFor(OWNER_A, TOKEN)).toEqual([a.mandateDigest, b.mandateDigest]);

    store.update(a.mandateDigest, { status: 'settling' }, 2);
    expect(store.reserved(OWNER_A, TOKEN)).toBe(850_000n); // settling still reserves
    for (const [digest, status] of [
      [a.mandateDigest, 'settled'],
      [b.mandateDigest, 'expired'],
    ] as [Hex, RecordStatus][]) {
      store.update(digest, { status }, 3);
    }
    expect(store.reserved(OWNER_A, TOKEN)).toBe(0n);
    expect(store.unsettledFor(OWNER_A, TOKEN)).toEqual([]);
    store.update(other.mandateDigest, { status: 'failed', errorCode: 'nonce_used' }, 4);
    expect(store.reserved(OWNER_B, TOKEN)).toBe(0n);
    // a settling record requeued to pending keeps its reservation
    const c = rec({ mandate: { amount: '5' } });
    store.insert(c);
    store.update(c.mandateDigest, { status: 'settling' }, 5);
    store.update(c.mandateDigest, { status: 'pending' }, 6);
    expect(store.reserved(OWNER_A, TOKEN)).toBe(5n);
  });

  it('persists enq/upd events and folds them back on open', () => {
    const path = tmpStorePath('fold');
    const w = new JsonlStore(path);
    const a = rec({ mandate: { amount: '100' } });
    const b = rec({ mandate: { amount: '200' } });
    w.insert(a);
    w.insert(b);
    w.update(a.mandateDigest, { status: 'settling', sentBlock: 7 }, 10);
    w.update(a.mandateDigest, { status: 'settled', txHash: `0x${'bb'.repeat(32)}` }, 11);
    w.update(b.mandateDigest, { status: 'pending', attempts: 1, nextAttemptAt: 99 }, 12);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0])).toMatchObject({ t: 'enq', rec: { mandateDigest: a.mandateDigest } });
    expect(JSON.parse(lines[2])).toMatchObject({ t: 'upd', digest: a.mandateDigest, patch: { status: 'settling', sentBlock: 7 }, at: 10 });

    const r = new JsonlStore(path);
    expect(r.size).toBe(2);
    expect(r.get(a.mandateDigest)).toEqual({ ...a, status: 'settled', sentBlock: 7, txHash: `0x${'bb'.repeat(32)}`, updatedAt: 11 });
    expect(r.get(b.mandateDigest)).toEqual({ ...b, attempts: 1, nextAttemptAt: 99, updatedAt: 12 });
    expect(r.reserved(OWNER_A, TOKEN)).toBe(200n);
    expect(r.digestForNonce(OWNER_A, b.mandate.nonce)).toBe(b.mandateDigest);
    expect(r.counts()).toEqual({ pending: 1, settling: 0, settled: 1, failed: 0, expired: 0 });
  });

  it('drops a truncated last line, repairs the file and keeps appending cleanly', () => {
    const path = tmpStorePath('truncated');
    const w = new JsonlStore(path);
    const a = rec();
    w.insert(a);
    const good = readFileSync(path, 'utf8');
    appendFileSync(path, '{"t":"upd","digest":"0x00","patch":{"status":"set', 'utf8'); // crash mid-write

    const warnings: string[] = [];
    const r = new JsonlStore(path, (line) => warnings.push(line));
    expect(r.size).toBe(1);
    expect(r.get(a.mandateDigest)?.status).toBe('pending');
    expect(warnings.join('\n')).toMatch(/truncated last line/);
    expect(readFileSync(path, 'utf8')).toBe(good);

    r.update(a.mandateDigest, { status: 'expired' }, 5);
    const again = new JsonlStore(path);
    expect(again.get(a.mandateDigest)?.status).toBe('expired');
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(3); // 2 lines + trailing newline
  });

  it('keeps a complete but unterminated last line', () => {
    const path = tmpStorePath('unterminated');
    const a = rec();
    writeFileSync(path, JSON.stringify({ t: 'enq', rec: a }), 'utf8'); // no trailing newline
    const r = new JsonlStore(path);
    expect(r.size).toBe(1);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('refuses a corrupt line that is not the last one', () => {
    const path = tmpStorePath('corrupt');
    const a = rec();
    writeFileSync(path, `${JSON.stringify({ t: 'enq', rec: a })}\n{"t":"upd","dig\n${JSON.stringify({ t: 'upd', digest: a.mandateDigest, patch: {}, at: 1 })}\n`, 'utf8');
    expect(() => new JsonlStore(path)).toThrow(/corrupt store line 2/);
    writeFileSync(path, `${JSON.stringify({ t: 'bogus' })}\n`, 'utf8');
    expect(() => new JsonlStore(path)).toThrow(/unknown event type/);
  });

  it('a failed append leaves memory untouched and surfaces the error', () => {
    const path = tmpStorePath('unwritable');
    const store = new JsonlStore(path);
    const a = rec({ mandate: { amount: '700' } });
    store.insert(a);
    // Turn the file into a directory: every append from here on fails with EISDIR.
    rmSync(path);
    mkdirSync(path);

    const b = rec({ mandate: { amount: '300' } });
    expect(() => store.insert(b)).toThrow(/EISDIR/);
    expect(store.size).toBe(1);
    expect(store.has(b.mandateDigest)).toBe(false);
    expect(store.digestForNonce(OWNER_A, b.mandate.nonce)).toBeUndefined();
    expect(store.reserved(OWNER_A, TOKEN)).toBe(700n);
    expect(store.pending).toBe(1);

    expect(() => store.update(a.mandateDigest, { status: 'settled', txHash: `0x${'cc'.repeat(32)}` }, 5)).toThrow(/EISDIR/);
    expect(store.get(a.mandateDigest)).toMatchObject({ status: 'pending', updatedAt: a.enqueuedAt });
    expect(store.get(a.mandateDigest)?.txHash).toBeUndefined();
    expect(store.reserved(OWNER_A, TOKEN)).toBe(700n);
    expect(store.pending).toBe(1);
  });

  it('pending counts records in status pending across inserts, updates and replay', () => {
    const path = tmpStorePath('pending');
    const w = new JsonlStore(path);
    expect(w.pending).toBe(0);
    const a = rec();
    const b = rec();
    const c = rec({ status: 'settled' });
    for (const r of [a, b, c]) w.insert(r);
    expect(w.pending).toBe(2);
    w.update(a.mandateDigest, { status: 'settling' }, 1);
    expect(w.pending).toBe(1);
    w.update(a.mandateDigest, { status: 'pending', nextAttemptAt: 9 }, 2); // requeued after a transport failure
    expect(w.pending).toBe(2);
    w.update(b.mandateDigest, { status: 'expired' }, 3);
    w.update(a.mandateDigest, { attempts: 1 }, 4); // status untouched
    expect(w.pending).toBe(1);
    expect(w.pending).toBe(w.counts().pending);
    expect(new JsonlStore(path).pending).toBe(1);
  });

  it('tolerates replayed duplicates and updates for unknown digests', () => {
    const path = tmpStorePath('tolerant');
    const a = rec();
    writeFileSync(
      path,
      [
        JSON.stringify({ t: 'upd', digest: `0x${'ee'.repeat(32)}`, patch: { status: 'settled' }, at: 1 }),
        JSON.stringify({ t: 'enq', rec: a }),
        JSON.stringify({ t: 'enq', rec: { ...a, status: 'failed' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    const r = new JsonlStore(path);
    expect(r.size).toBe(1);
    expect(r.get(a.mandateDigest)?.status).toBe('pending'); // first enq wins
  });
});
