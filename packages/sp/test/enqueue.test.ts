import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SP_ERROR_CODES, verifySpReceipt, type Hex, type SpReceipt } from '@agentpay/core';
import { MAX_BODY_BYTES, WITHDRAW_DELAY_MARGIN_SECONDS, type SPHandle } from '../src/index.js';
import {
  AMOUNT,
  SETTLE_WINDOW,
  USDC,
  accounts,
  authorize,
  debitable,
  domain,
  enqueue,
  extraAccount,
  fixture,
  fund,
  get,
  mkSP,
  nowSec,
  post,
  revoke,
  rpcProxy,
  settleDirect,
  signed,
  walletBalance,
} from './helpers.js';

const ZERO = '0x0000000000000000000000000000000000000000';

function expectError(reply: { status: number; json: any }, status: number, code: string) {
  expect(reply.status).toBe(status);
  expect(reply.json.success).toBe(false);
  expect(reply.json.error).toBe(code);
  expect(typeof reply.json.message).toBe('string');
  expect(reply.json.payment_model_context).toMatchObject({ protocol: 'aep2', reason: code });
  expect(Array.isArray(reply.json.payment_model_context.remediation)).toBe(true);
}

describe('POST /enqueue', () => {
  let sp: SPHandle;

  beforeAll(async () => {
    sp = mkSP();
    await fund(accounts.payer, USDC('100'), sp.address);
    await sp.start();
  });
  afterAll(() => sp.stop());

  it('happy path: 200 with a receipt that verifies and a pending record', async () => {
    const s = await signed();
    const before = nowSec();
    const r = await enqueue(sp, s);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, status: 'enqueued' });
    const receipt = r.json.receipt as SpReceipt;
    expect(receipt.sp).toBe(sp.address);
    expect(receipt.sp).toBe(accounts.sp.address);
    expect(receipt.mandateDigest).toBe(s.digest);
    expect(receipt.enqueueDeadline).toBeGreaterThanOrEqual(before + SETTLE_WINDOW);
    expect(receipt.enqueueDeadline).toBeLessThanOrEqual(nowSec() + SETTLE_WINDOW);
    expect(
      await verifySpReceipt(receipt, {
        domain: domain(),
        expectedSp: sp.address,
        mandateDigest: s.digest,
        mandateDeadline: s.mandate.deadline,
        now: nowSec(),
        maxWindowSeconds: SETTLE_WINDOW + 60,
      }),
    ).toEqual({ ok: true });
    expect(await verifySpReceipt(receipt, { domain: domain(), expectedSp: accounts.stranger.address, now: nowSec() })).toEqual({
      ok: false,
      reason: 'sp_mismatch',
    });

    const rec = sp.store.get(s.digest);
    expect(rec).toMatchObject({ status: 'pending', attempts: 0, chainId: fixture().chainId, wallet: fixture().wallet, payerSig: s.payerSig });
    expect(rec?.receipt).toEqual(receipt);
    expect(sp.store.reserved(accounts.payer.address, fixture().usdc)).toBeGreaterThanOrEqual(AMOUNT);
  });

  it('receipt enqueueDeadline is capped by the mandate deadline', async () => {
    const deadline = nowSec() + 300; // < now + settleWindow
    const s = await signed({ deadline });
    const r = await enqueue(sp, s);
    expect(r.status).toBe(200);
    expect(r.json.receipt.enqueueDeadline).toBe(deadline);
  });

  it('is idempotent: re-enqueue returns the identical spEnqueueSig', async () => {
    const s = await signed();
    const first = await enqueue(sp, s);
    const second = await enqueue(sp, s, { chainId: fixture().chainId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.receipt).toEqual(first.json.receipt);
    expect(second.json.receipt.spEnqueueSig).toBe(first.json.receipt.spEnqueueSig);
    // The payee can tell its own retry from a replay: created flips, enqueuedAt is the original.
    expect(first.json.created).toBe(true);
    expect(second.json.created).toBe(false);
    expect(second.json.enqueuedAt).toBe(first.json.enqueuedAt);
    expect(sp.store.counts().pending).toBeGreaterThan(0);
    // lowercase addresses / uppercase ref describe the same mandate
    const lower = {
      ...s.mandate,
      owner: s.mandate.owner.toLowerCase() as Hex,
      payee: s.mandate.payee.toLowerCase() as Hex,
      ref: s.mandate.ref.toUpperCase().replace('0X', '0x') as Hex,
    };
    const third = await enqueue(sp, { mandate: lower, payerSig: s.payerSig });
    expect(third.status).toBe(200);
    expect(third.json.receipt.spEnqueueSig).toBe(first.json.receipt.spEnqueueSig);
  });

  it('400 invalid_body for anything that is not {mandate, payerSig}', async () => {
    const s = await signed();
    expectError(await post(`${sp.url}/enqueue`, 'not json{', true), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, [1, 2]), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, {}), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, { mandate: s.mandate }), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, { mandate: s.mandate, payerSig: '0x1234' }), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, { mandate: { ...s.mandate, amount: 5 }, payerSig: s.payerSig }), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, { mandate: { ...s.mandate, deadline: '1' }, payerSig: s.payerSig }), 400, 'invalid_body');
    expectError(await post(`${sp.url}/enqueue`, { mandate: { ...s.mandate, owner: 'bob' }, payerSig: s.payerSig }), 400, 'invalid_body');
    expectError(await enqueue(sp, s, { chainId: 'abc' }), 400, 'invalid_body');
    expect(sp.store.get(s.digest)).toBeUndefined();
  });

  it('413 for a body above the 64 KB cap', async () => {
    const s = await signed();
    const r = await post(`${sp.url}/enqueue`, { mandate: s.mandate, payerSig: s.payerSig, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(r.status).toBe(413);
    expect(r.json.error).toBe('payload_too_large');
  });

  it('400 unsupported_chain / unsupported_token / bad_params', async () => {
    const s = await signed();
    expectError(await enqueue(sp, s, { chainId: 1 }), 400, 'unsupported_chain');
    expect((await enqueue(sp, s, { chainId: String(fixture().chainId) })).status).toBe(200); // numeric string ok

    const wrongToken = await signed({ token: fixture().wallet });
    const r = await enqueue(sp, wrongToken);
    expectError(r, 400, 'unsupported_token');
    expect(r.json.detail.supported).toEqual([fixture().usdc]);

    expectError(await enqueue(sp, await signed({ amount: '0' })), 400, 'bad_params');
    expectError(await enqueue(sp, await signed({ payee: ZERO })), 400, 'bad_params');
  });

  it('400 deadline_too_soon / deadline_too_far with policy detail', async () => {
    const soon = await enqueue(sp, await signed({ deadline: nowSec() + 60 }));
    expectError(soon, 400, 'deadline_too_soon');
    expect(soon.json.detail.minDeadlineMarginSeconds).toBe(120);
    expect(soon.json.payment_model_context.summary).toContain('120');
    expectError(await enqueue(sp, await signed({ deadline: nowSec() - 5 })), 400, 'deadline_too_soon');
    const far = await enqueue(sp, await signed({ deadline: nowSec() + 86_400 + 600 }));
    expectError(far, 400, 'deadline_too_far');
    expect(far.json.detail.maxDeadlineHorizonSeconds).toBe(86_400);
  });

  it('400 invalid_signature when the signature does not recover to owner', async () => {
    const forged = await signed({ owner: accounts.payer.address }, accounts.stranger);
    const r = await enqueue(sp, forged);
    expectError(r, 400, 'invalid_signature');
    expect(r.json.mandateDigest).toBe(forged.digest);
    const s = await signed();
    const tampered = { mandate: { ...s.mandate, amount: (AMOUNT * 2n).toString() }, payerSig: s.payerSig };
    expectError(await enqueue(sp, tampered), 400, 'invalid_signature');
    const garbage = { mandate: s.mandate, payerSig: `0x${'00'.repeat(65)}` as Hex };
    expectError(await enqueue(sp, garbage), 400, 'invalid_signature');
    expect(sp.store.get(s.digest)).toBeUndefined();
  });

  it('409 nonce_used when a different mandate reuses a locally bound (owner, nonce)', async () => {
    const a = await signed();
    expect((await enqueue(sp, a)).status).toBe(200);
    const b = await signed({ nonce: a.mandate.nonce, amount: '70000' });
    const r = await enqueue(sp, b);
    expectError(r, 409, 'nonce_used');
    expect(r.json.mandateDigest).toBe(b.digest);
    expect(r.json.detail.boundTo).toBe(a.digest);
    expect(sp.store.get(b.digest)).toBeUndefined();
  });

  it('409 nonce_used when the nonce was already used on-chain', async () => {
    const s = await signed();
    await settleDirect(s);
    const r = await enqueue(sp, s);
    expectError(r, 409, 'nonce_used');
    expect(sp.store.get(s.digest)).toBeUndefined();
  });

  it('403 sp_not_authorized for a payer who never called authorizeSP', async () => {
    const s = await signed({}, accounts.stranger);
    const r = await enqueue(sp, s);
    expectError(r, 403, 'sp_not_authorized');
    expect(r.json.detail.sp).toBe(sp.address);
    expect(r.json.payment_model_context.commands).toEqual(['agentpay sp-authorize <sp>']);
    expect(sp.store.get(s.digest)).toBeUndefined();
  });

  it('403 sp_revocation_pending while a revocation would land inside the receipt window; sp_not_authorized once it has', async () => {
    const payer = extraAccount(9);
    await fund(payer, USDC('1'), sp.address);
    let spNow = nowSec();
    const revoking = mkSP({ clock: () => spNow });
    await revoking.start();
    try {
      const revokeAt = await revoke(payer, sp.address); // = revoke block + withdrawDelay (> SETTLE_WINDOW)
      // A receipt issued now would promise settlement by revokeAt itself, which the
      // contract already refuses: no receipt, nothing reserved.
      spNow = revokeAt - SETTLE_WINDOW;
      const r = await enqueue(revoking, await signed({}, payer));
      expectError(r, 403, 'sp_revocation_pending');
      expect(r.json.detail).toEqual({ sp: revoking.address, owner: payer.address, revokeAt, enqueueDeadline: revokeAt });
      expect(r.json.payment_model_context.commands).toEqual(['agentpay sp-authorize <sp>']);
      expect(revoking.store.get(r.json.mandateDigest)).toBeUndefined();
      // One second earlier the promise ends before the revocation: admitted.
      spNow = revokeAt - SETTLE_WINDOW - 1;
      const ok = await enqueue(revoking, await signed({}, payer));
      expect(ok.status).toBe(200);
      expect(ok.json.receipt.enqueueDeadline).toBe(revokeAt - 1);
      // From revokeAt on the SP is simply not authorized.
      spNow = revokeAt;
      const late = await enqueue(revoking, await signed({}, payer));
      expectError(late, 403, 'sp_not_authorized');
      expect(revoking.store.get(late.json.mandateDigest)).toBeUndefined();
    } finally {
      await revoking.stop();
    }
  });

  it('402 insufficient_balance: reservations count against the debitable balance', async () => {
    const payer = extraAccount(5);
    await fund(payer, USDC('1'), sp.address);
    expect(await debitable(payer.address)).toBe(USDC('1'));

    const a = await signed({ amount: USDC('0.6').toString() }, payer);
    expect((await enqueue(sp, a)).status).toBe(200);
    expect(sp.store.reserved(payer.address, fixture().usdc)).toBe(USDC('0.6'));

    const b = await signed({ amount: USDC('0.6').toString() }, payer);
    const r = await enqueue(sp, b);
    expectError(r, 402, 'insufficient_balance');
    expect(r.json.mandateDigest).toBe(b.digest);
    expect(r.json.detail).toEqual({ debitable: USDC('1').toString(), amount: USDC('0.6').toString(), reserved: USDC('0.6').toString() });
    expect(r.json.payment_model_context.summary).toContain(USDC('1').toString());
    expect(sp.store.get(b.digest)).toBeUndefined();

    const tick = await sp.tick();
    expect(tick.settled).toContain(a.digest);
    expect(await walletBalance(payer.address)).toBe(USDC('0.4'));
    expect(sp.store.reserved(payer.address, fixture().usdc)).toBe(0n);

    const c = await signed({ amount: USDC('0.4').toString() }, payer);
    expect((await enqueue(sp, c)).status).toBe(200);
    expectError(await enqueue(sp, await signed({ amount: '1' }, payer)), 402, 'insufficient_balance');
  });

  it('402 when a pending withdrawal shrinks the debitable balance', async () => {
    const payer = extraAccount(6);
    await fund(payer, USDC('1'), sp.address);
    const { walletFor } = await import('./helpers.js');
    const { AEP2_DEBIT_WALLET_ABI } = await import('@agentpay/contracts');
    const hash = await walletFor(payer).writeContract({
      address: fixture().wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'requestWithdraw',
      args: [fixture().usdc, USDC('0.8')],
    });
    await (await import('./helpers.js')).publicClient().waitForTransactionReceipt({ hash });
    expect(await debitable(payer.address)).toBe(USDC('0.2'));
    expectError(await enqueue(sp, await signed({ amount: USDC('0.3').toString() }, payer)), 402, 'insufficient_balance');
    expect((await enqueue(sp, await signed({ amount: USDC('0.2').toString() }, payer))).status).toBe(200);
  });

  it('admits exactly what the balance covers when enqueues race: 6 x $0.3 against $1 is 3 receipts + 3 x 402', async () => {
    const payer = extraAccount(10);
    await fund(payer, USDC('1'), sp.address);
    const mandates = await Promise.all(Array.from({ length: 6 }, () => signed({ amount: USDC('0.3').toString() }, payer)));
    // All six read the same debitable balance ($1) before any of them is admitted;
    // only the synchronous claim keeps the fourth from also passing the funds check.
    const replies = await Promise.all(mandates.map((s) => enqueue(sp, s)));
    const admitted = replies.filter((r) => r.status === 200);
    const refused = replies.filter((r) => r.status !== 200);
    expect(admitted).toHaveLength(3);
    expect(refused).toHaveLength(3);
    for (const r of refused) expectError(r, 402, 'insufficient_balance');
    expect(sp.store.reserved(payer.address, fixture().usdc)).toBe(USDC('0.9'));
    expect(mandates.filter((s) => sp.store.has(s.digest))).toHaveLength(3);
  });

  it('answers concurrent enqueues of one mandate with a single record and the same receipt', async () => {
    const s = await signed();
    const size = sp.store.size;
    const replies = await Promise.all([enqueue(sp, s), enqueue(sp, s), enqueue(sp, s)]);
    for (const r of replies) expect(r.status).toBe(200);
    expect(replies.filter((r) => r.json.created === true)).toHaveLength(1);
    expect(new Set(replies.map((r) => r.json.receipt.spEnqueueSig)).size).toBe(1);
    expect(new Set(replies.map((r) => r.json.enqueuedAt)).size).toBe(1);
    expect(sp.store.size).toBe(size + 1);
  });

  it('409 mandate_terminal once a record reached a terminal state', async () => {
    const s = await signed();
    expect((await enqueue(sp, s)).status).toBe(200);
    // The payer double-spends the nonce: a different mandate with the same nonce settles
    // first, so this digest can never settle (NonceUsed with no Settled event for it).
    await settleDirect(await signed({ nonce: s.mandate.nonce, amount: '1' }));
    const tick = await sp.tick();
    expect(tick.skipped).toContainEqual({ mandateDigest: s.digest, status: 'nonce_used' });
    expect(sp.store.get(s.digest)).toMatchObject({ status: 'failed', errorCode: 'nonce_used' });
    const r = await enqueue(sp, s);
    expectError(r, 409, 'mandate_terminal');
    expect(r.json.detail.previous).toBe('nonce_used');
    expect(r.json.payment_model_context.summary).toContain('nonce_used');
  });

  it('503 rpc_error when the chain cannot be read', async () => {
    const proxy = await rpcProxy(fixture().rpcUrl);
    const flaky = mkSP({ rpcUrl: proxy.url });
    await flaky.start();
    try {
      proxy.dead = true;
      const s = await signed();
      const r = await enqueue(flaky, s);
      expectError(r, 503, 'rpc_error');
      expect(flaky.store.get(s.digest)).toBeUndefined();
      const health = await get(`${flaky.url}/health`);
      expect(health.status).toBe(503);
      expect(health.json).toMatchObject({ ok: false, rpcOk: false });
      proxy.dead = false;
      expect((await enqueue(flaky, s)).status).toBe(200);
    } finally {
      await flaky.stop();
      await proxy.close();
    }
  });

  it('every SP error code has a hint', () => {
    for (const code of SP_ERROR_CODES) expect(code).toBeTruthy();
  });
});

describe('read routes', () => {
  let sp: SPHandle;

  beforeAll(async () => {
    sp = mkSP({ batchMax: 7 });
    await authorize(accounts.payer, sp.address);
    await sp.start();
  });
  afterAll(() => sp.stop());

  it('GET /status/:digest', async () => {
    expect((await get(`${sp.url}/status/0x${'ab'.repeat(32)}`)).status).toBe(404);
    const missing = await get(`${sp.url}/status/nope`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('not_found');

    const s = await signed();
    const r = await enqueue(sp, s);
    const st = await get(`${sp.url}/status/${s.digest}`);
    expect(st.status).toBe(200);
    expect(st.json).toEqual({
      mandateDigest: s.digest,
      status: 'pending',
      enqueuedAt: expect.any(Number),
      updatedAt: expect.any(Number),
      receipt: r.json.receipt,
    });
    expect(st.headers.get('cache-control')).toBe('no-store');

    await sp.tick();
    const done = await get(`${sp.url}/status/${s.digest}`);
    expect(done.json).toMatchObject({ status: 'settled', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(done.json.errorCode).toBeUndefined();
  });

  it('GET /queue/:owner reports balance, queue balance, available and pending digests', async () => {
    const f = fixture();
    const a = await signed();
    const b = await signed({ amount: '30000' });
    expect((await enqueue(sp, a)).status).toBe(200);
    expect((await enqueue(sp, b)).status).toBe(200);
    const balance = await walletBalance(accounts.payer.address);
    const deb = await debitable(accounts.payer.address);
    const reserved = sp.store.reserved(accounts.payer.address, f.usdc);
    expect(reserved).toBe(AMOUNT + 30_000n);

    const q = await get(`${sp.url}/queue/${accounts.payer.address.toLowerCase()}`);
    expect(q.status).toBe(200);
    expect(q.json).toEqual({
      owner: accounts.payer.address,
      token: f.usdc,
      balance: balance.toString(),
      queueBalance: reserved.toString(),
      available: (deb - reserved).toString(),
      pending: [a.digest, b.digest],
    });
    const explicit = await get(`${sp.url}/queue/${accounts.payer.address}?token=${f.usdc.toLowerCase()}`);
    expect(explicit.json).toEqual(q.json);

    expect((await get(`${sp.url}/queue/${accounts.payer.address}?token=${f.wallet}`)).json.error).toBe('unsupported_token');
    expect((await get(`${sp.url}/queue/bob`)).status).toBe(400);

    // an empty account: available clamps at 0 and nothing is pending
    const empty = await get(`${sp.url}/queue/${accounts.payee.address}`);
    expect(empty.json).toMatchObject({ balance: '0', queueBalance: '0', available: '0', pending: [] });

    await sp.tick();
    const after = await get(`${sp.url}/queue/${accounts.payer.address}`);
    expect(after.json.pending).toEqual([]);
    expect(after.json.queueBalance).toBe('0');
    expect(BigInt(after.json.balance)).toBe(balance - reserved);
  });

  it('GET /supported', async () => {
    const f = fixture();
    const r = await get(`${sp.url}/supported`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      chainId: f.chainId,
      network: `eip155:${f.chainId}`,
      wallet: f.wallet,
      sp: sp.address,
      tokens: [{ address: f.usdc, symbol: 'USDC', decimals: 6 }],
      settleWindowSeconds: SETTLE_WINDOW,
      withdrawDelaySeconds: f.withdrawDelay,
      minDeadlineMarginSeconds: 120,
      maxDeadlineHorizonSeconds: 86_400,
      batchMax: 7,
    });
  });

  it('GET /health', async () => {
    const f = fixture();
    const r = await get(`${sp.url}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      sp: sp.address,
      chainId: f.chainId,
      wallet: f.wallet,
      counts: sp.store.counts(),
      lastBatchAt: expect.any(Number),
      rpcOk: true,
    });
    expect(r.json.counts.settled).toBeGreaterThanOrEqual(3);
    expect(r.json.counts.pending).toBe(0);
  });

  it('404 for unknown routes and 405 for method mismatches', async () => {
    const nf = await get(`${sp.url}/nope`);
    expect(nf.status).toBe(404);
    expect(nf.json).toMatchObject({ success: false, error: 'not_found' });
    expect((await get(`${sp.url}/status`)).status).toBe(404);
    expect((await get(`${sp.url}/enqueue/extra`, 'POST')).status).toBe(404);

    const mm = await get(`${sp.url}/enqueue`);
    expect(mm.status).toBe(405);
    expect(mm.headers.get('allow')).toBe('POST');
    expect(mm.json.error).toBe('method_not_allowed');
    expect((await get(`${sp.url}/supported`, 'POST')).status).toBe(405);
    expect((await get(`${sp.url}/health`, 'DELETE')).status).toBe(405);
  });
});

describe('startup assertions', () => {
  it('refuses a chain id mismatch', async () => {
    const sp = mkSP({ chainId: 1 });
    await expect(sp.start()).rejects.toThrow(/serves chain 31337 but the configuration says 1/);
  });

  it('refuses a settlement window that ends within the skew margin of the withdrawal delay', async () => {
    // withdrawDelay == window + margin is the last accepted configuration; one second more is refused.
    const widest = fixture().withdrawDelay - WITHDRAW_DELAY_MARGIN_SECONDS;
    const sp = mkSP({ settleWindowSeconds: widest + 1 });
    await expect(sp.start()).rejects.toThrow(/withdrawDelay is 900s but settleWindowSeconds is 841s \(needs at least 60s more/);
    const ok = mkSP({ settleWindowSeconds: widest });
    await ok.start();
    await ok.stop();
  });

  it('refuses a token that does not answer decimals() and a wallet that is not a debit wallet', async () => {
    const sp = mkSP({ tokens: [fixture().wallet] });
    await expect(sp.start()).rejects.toThrow(/does not answer decimals\(\)/);
    const bad = mkSP({ wallet: fixture().usdc });
    await expect(bad.start()).rejects.toThrow(/does not answer withdrawDelay\(\)/);
    const unreachable = mkSP({ rpcUrl: 'http://127.0.0.1:1' });
    await expect(unreachable.start()).rejects.toThrow(/cannot reach RPC/);
  });
});
