import { beforeAll, describe, expect, it } from 'vitest';
import { parseEventLogs, parseUnits, type Abi, type Address } from 'viem';
import { mandateDigest } from '@agentpay/core';
import { AEP2_DEBIT_WALLET_ABI } from '../src/index.js';
import {
  AMOUNT,
  WITHDRAW_DELAY,
  accounts,
  authorizationOf,
  authorizeSpFor,
  balanceOf,
  debitable,
  deployFeeToken,
  deployFixture,
  depositFor,
  domainFor,
  nonceUsed,
  now,
  publicClient,
  setSpAuthorization,
  settleAs,
  signedMandate,
  spAuthorized,
  timeTravel,
  tuple,
  walletBalance,
  wallets,
  type Fixture,
} from './helpers.js';

describe('AEP2DebitWallet', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await deployFixture();
    await depositFor(f, 'payer', parseUnits('100', 6));
    await authorizeSpFor(f, 'payer', accounts.sp.address);
  });

  /** I1: the contract always holds at least the sum of the balances it owes. */
  async function assertSolvent(): Promise<void> {
    const held = await balanceOf(f.usdc, f.wallet);
    const owed =
      (await walletBalance(f, accounts.payer.address)) + (await walletBalance(f, accounts.stranger.address));
    expect(held).toBeGreaterThanOrEqual(owed);
  }

  it('mandateDigest byte-matches core mandateDigest', async () => {
    const s = await signedMandate(f);
    const onChain = await publicClient.readContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'mandateDigest',
      args: [tuple(s.mandate)],
    });
    expect(onChain).toBe(s.digest);
    expect(onChain).toBe(mandateDigest(domainFor(f), s.mandate));
  });

  it('deposit credits balances and emits; zero amount reverts', async () => {
    const before = await walletBalance(f, accounts.payer.address);
    await depositFor(f, 'payer', 1_000_000n);
    expect(await walletBalance(f, accounts.payer.address)).toBe(before + 1_000_000n);
    await expect(
      wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'deposit',
        args: [f.usdc, 0n],
      }),
    ).rejects.toThrow(/BadParams/);
    await assertSolvent();
  });

  it('deposit credits what arrived: a fee-on-transfer token credits less, a transfer of nothing reverts', async () => {
    const payer = accounts.payer.address;
    const custody = (token: Address) =>
      publicClient.readContract({ address: f.wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName: 'balances', args: [payer, token] });
    /** mint + approve + deposit `amount` of `token` as the payer; resolves to the deposit receipt. */
    async function fundAndDeposit(token: { address: Address; abi: Abi }, amount: bigint) {
      for (const [functionName, args] of [['mint', [payer, amount]], ['approve', [f.wallet, amount]]] as const) {
        const hash = await wallets.payer.writeContract({ address: token.address, abi: token.abi, functionName, args });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      const hash = await wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'deposit',
        args: [token.address, amount],
      });
      return publicClient.waitForTransactionReceipt({ hash });
    }

    // 1% is burned on the way in: the payer is credited 990_000, never the 1_000_000 it asked for.
    const fee = await deployFeeToken(100n);
    const receipt = await fundAndDeposit(fee, 1_000_000n);
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'Deposited' });
    expect(ev.args).toEqual({ owner: payer, token: fee.address, amount: 990_000n });
    expect(await custody(fee.address)).toBe(990_000n);
    // I1 holds for this token as well: the contract holds at least what it owes.
    const held = (await publicClient.readContract({ address: fee.address, abi: fee.abi, functionName: 'balanceOf', args: [f.wallet] })) as bigint;
    expect(held).toBeGreaterThanOrEqual(990_000n);

    // transferFrom succeeds but nothing arrives: refuse rather than credit custody the contract does not hold.
    const burn = await deployFeeToken(10_000n);
    await expect(fundAndDeposit(burn, 1_000_000n)).rejects.toThrow(/BadParams/);
    expect(await custody(burn.address)).toBe(0n);
  });

  it('settle pays the payee, marks the nonce, debits the payer and emits Settled', async () => {
    const s = await signedMandate(f);
    const payeeBefore = await balanceOf(f.usdc, accounts.payee.address);
    const payerBefore = await walletBalance(f, accounts.payer.address);

    const receipt = await settleAs(f, 'sp', s);
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'Settled' });
    expect(ev.args.owner).toBe(accounts.payer.address);
    expect(ev.args.payee).toBe(accounts.payee.address);
    expect(ev.args.amount).toBe(AMOUNT);
    expect(ev.args.nonce).toBe(BigInt(s.mandate.nonce));
    expect(ev.args.ref).toBe(s.mandate.ref);
    expect(ev.args.mandateDigest).toBe(s.digest);

    expect(await balanceOf(f.usdc, accounts.payee.address)).toBe(payeeBefore + AMOUNT);
    expect(await walletBalance(f, accounts.payer.address)).toBe(payerBefore - AMOUNT);
    expect(await nonceUsed(f, accounts.payer.address, s.mandate.nonce)).toBe(true);
    await assertSolvent();
  });

  it('only a settlement processor the payer authorized can settle', async () => {
    const s = await signedMandate(f);
    await expect(settleAs(f, 'stranger', s)).rejects.toThrow(/SPNotAuthorized/);
    await expect(settleAs(f, 'payee', s)).rejects.toThrow(/SPNotAuthorized/);
    expect(await spAuthorized(f, accounts.payer.address, accounts.stranger.address)).toBe(false);
    expect(await spAuthorized(f, accounts.payer.address, accounts.sp.address)).toBe(true);
    await settleAs(f, 'sp', s);

    await expect(
      wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'authorizeSP',
        args: ['0x0000000000000000000000000000000000000000'],
      }),
    ).rejects.toThrow(/BadParams/);
  });

  it('revokeSP takes effect after withdrawDelay: mandates receipted before it still settle', async () => {
    const payer = accounts.payer.address;
    const sp = accounts.sp.address;
    // (4) nothing to revoke for an SP that was never authorized
    await expect(setSpAuthorization(f, 'payer', 'revokeSP', accounts.stranger.address)).rejects.toThrow(/BadParams/);

    const receipted = await signedMandate(f); // in the SP's queue when the payer revokes
    const receipt = await setSpAuthorization(f, 'payer', 'revokeSP', sp);
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'SPRevocationScheduled' });
    const revokeAt = (await now()) + WITHDRAW_DELAY;
    expect(ev.args).toEqual({ owner: payer, sp, revokeAt: BigInt(revokeAt) });
    expect(await authorizationOf(f, payer, sp)).toEqual({ enabled: true, revokeAt });

    // (1) during the delay: still authorized, the receipted mandate settles, a repeat keeps the date
    expect(await spAuthorized(f, payer, sp)).toBe(true);
    await timeTravel(10);
    const again = await setSpAuthorization(f, 'payer', 'revokeSP', sp);
    expect(parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: again.logs, eventName: 'SPRevocationScheduled' })).toEqual([]);
    expect(await authorizationOf(f, payer, sp)).toEqual({ enabled: true, revokeAt });
    await settleAs(f, 'sp', receipted);

    // after the delay: SPNotAuthorized, and the record shows why
    await timeTravel(WITHDRAW_DELAY);
    expect(await spAuthorized(f, payer, sp)).toBe(false);
    expect(await authorizationOf(f, payer, sp)).toEqual({ enabled: true, revokeAt });
    const late = await signedMandate(f);
    await expect(settleAs(f, 'sp', late)).rejects.toThrow(/SPNotAuthorized/);
    // an effective revocation is not cancellable; re-authorizing is the way back
    await expect(setSpAuthorization(f, 'payer', 'cancelRevoke', sp)).rejects.toThrow(/BadParams/);

    // (3) authorizeSP re-enables and clears revokeAt
    const back = await setSpAuthorization(f, 'payer', 'authorizeSP', sp);
    const [auth] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: back.logs, eventName: 'SPAuthorized' });
    expect(auth.args).toEqual({ owner: payer, sp, enabled: true });
    expect(await authorizationOf(f, payer, sp)).toEqual({ enabled: true, revokeAt: 0 });
    await settleAs(f, 'sp', late);
    await assertSolvent();
  });

  it('cancelRevoke restores the authorization; there must be a pending revocation to cancel', async () => {
    const payer = accounts.payer.address;
    const sp = accounts.sp.address;
    await expect(setSpAuthorization(f, 'payer', 'cancelRevoke', sp)).rejects.toThrow(/BadParams/);

    await setSpAuthorization(f, 'payer', 'revokeSP', sp);
    expect((await authorizationOf(f, payer, sp)).revokeAt).toBeGreaterThan(await now());
    const receipt = await setSpAuthorization(f, 'payer', 'cancelRevoke', sp);
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'SPAuthorized' });
    expect(ev.args).toEqual({ owner: payer, sp, enabled: true });
    expect(await authorizationOf(f, payer, sp)).toEqual({ enabled: true, revokeAt: 0 });

    // (2) the cancelled revocation never takes effect
    await timeTravel(WITHDRAW_DELAY + 1);
    expect(await spAuthorized(f, payer, sp)).toBe(true);
    await settleAs(f, 'sp', await signedMandate(f));
  });

  it('rejects a signature from the wrong signer and any tampered field', async () => {
    const wrongSigner = await signedMandate(f, {}, accounts.stranger);
    await expect(settleAs(f, 'sp', wrongSigner)).rejects.toThrow(/BadSignature/);

    const s = await signedMandate(f);
    const tampered = { ...s, mandate: { ...s.mandate, amount: (AMOUNT * 2n).toString() } };
    await expect(settleAs(f, 'sp', tampered)).rejects.toThrow(/BadSignature/);
    const otherPayee = { ...s, mandate: { ...s.mandate, payee: accounts.stranger.address } };
    await expect(settleAs(f, 'sp', otherPayee)).rejects.toThrow(/BadSignature/);
  });

  it('rejects an expired mandate', async () => {
    const s = await signedMandate(f, { deadline: (await now()) - 1 });
    await expect(settleAs(f, 'sp', s)).rejects.toThrow(/Expired/);
  });

  it('rejects a replayed mandate (nonce already used)', async () => {
    const s = await signedMandate(f);
    await settleAs(f, 'sp', s);
    await expect(settleAs(f, 'sp', s)).rejects.toThrow(/NonceUsed/);
  });

  it('rejects a mandate above the payer balance and a zero-amount mandate', async () => {
    const bal = await walletBalance(f, accounts.payer.address);
    const tooMuch = await signedMandate(f, { amount: (bal + 1n).toString() });
    await expect(settleAs(f, 'sp', tooMuch)).rejects.toThrow(/InsufficientBalance/);
    const zero = await signedMandate(f, { amount: '0' });
    await expect(settleAs(f, 'sp', zero)).rejects.toThrow(/BadParams/);
  });

  it('withdrawal: locked until the delay elapses, one pending at a time, cancellable', async () => {
    const amount = 5_000_000n;
    const req = await wallets.payer.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'requestWithdraw',
      args: [f.usdc, amount],
    });
    const reqReceipt = await publicClient.waitForTransactionReceipt({ hash: req });
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: reqReceipt.logs, eventName: 'WithdrawalRequested' });
    expect(ev.args.amount).toBe(amount);
    expect(Number(ev.args.unlockAt)).toBeGreaterThan(await now());

    const balance = await walletBalance(f, accounts.payer.address);
    expect(await debitable(f, accounts.payer.address)).toBe(balance - amount);

    await expect(
      wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'executeWithdraw',
        args: [f.usdc, accounts.payer.address],
      }),
    ).rejects.toThrow(/WithdrawalLocked/);
    await expect(
      wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'requestWithdraw',
        args: [f.usdc, 1n],
      }),
    ).rejects.toThrow(/WithdrawalPending/);

    const cancel = await wallets.payer.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'cancelWithdraw',
      args: [f.usdc],
    });
    await publicClient.waitForTransactionReceipt({ hash: cancel });
    expect(await debitable(f, accounts.payer.address)).toBe(balance);
    await expect(
      wallets.payer.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'executeWithdraw',
        args: [f.usdc, accounts.payer.address],
      }),
    ).rejects.toThrow(/NoWithdrawal/);

    // Request again, wait out the delay, execute to a third party.
    const req2 = await wallets.payer.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'requestWithdraw',
      args: [f.usdc, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: req2 });
    await timeTravel(WITHDRAW_DELAY + 1);
    const toBefore = await balanceOf(f.usdc, accounts.payee.address);
    const exec = await wallets.payer.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'executeWithdraw',
      args: [f.usdc, accounts.payee.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: exec });
    expect(await balanceOf(f.usdc, accounts.payee.address)).toBe(toBefore + amount);
    expect(await walletBalance(f, accounts.payer.address)).toBe(balance - amount);
    await assertSolvent();
  });

  it('settlement during a pending withdrawal wins; the withdrawal pays out only the remainder', async () => {
    // Fresh payer (stranger) so the arithmetic is exact: deposit 1.0, mandate 0.8, withdraw 1.0.
    await depositFor(f, 'stranger', 1_000_000n);
    await authorizeSpFor(f, 'stranger', accounts.sp.address);
    const s = await signedMandate(f, { owner: accounts.stranger.address, amount: '800000' }, accounts.stranger);

    const req = await wallets.stranger.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'requestWithdraw',
      args: [f.usdc, 1_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: req });
    expect(await debitable(f, accounts.stranger.address)).toBe(0n); // no NEW mandate would be admitted

    await settleAs(f, 'sp', s); // but an in-flight one still settles
    expect(await walletBalance(f, accounts.stranger.address)).toBe(200_000n);

    await timeTravel(WITHDRAW_DELAY + 1);
    const before = await balanceOf(f.usdc, accounts.stranger.address);
    const exec = await wallets.stranger.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'executeWithdraw',
      args: [f.usdc, accounts.stranger.address],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: exec });
    const [ev] = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'WithdrawalExecuted' });
    expect(ev.args.amount).toBe(200_000n);
    expect(await balanceOf(f.usdc, accounts.stranger.address)).toBe(before + 200_000n);
    expect(await walletBalance(f, accounts.stranger.address)).toBe(0n);
    await assertSolvent();
  });

  it('settleBatch skips bad items with SettleSkipped and pays the good ones', async () => {
    const ok1 = await signedMandate(f);
    const expired = await signedMandate(f, { deadline: (await now()) - 1 });
    const replayed = await signedMandate(f);
    await settleAs(f, 'sp', replayed); // consume the nonce first
    const badSig = await signedMandate(f, {}, accounts.stranger);
    const ok2 = await signedMandate(f, { payee: accounts.stranger.address, amount: '70000' });
    const items = [ok1, expired, replayed, badSig, ok2];

    const args = [items.map((s) => tuple(s.mandate)), items.map((s) => s.sig)] as const;
    const { result } = await publicClient.simulateContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settleBatch',
      args,
      account: accounts.sp,
    });
    expect([...result]).toEqual([0, 2, 3, 5, 0]); // Ok, Expired, NonceUsed, BadSignature, Ok

    const payeeBefore = await balanceOf(f.usdc, accounts.payee.address);
    const strangerBefore = await balanceOf(f.usdc, accounts.stranger.address);
    const hash = await wallets.sp.writeContract({
      address: f.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settleBatch',
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const settled = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'Settled' });
    const skipped = parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'SettleSkipped' });
    expect(settled.map((e) => e.args.mandateDigest)).toEqual([ok1.digest, ok2.digest]);
    expect(skipped.map((e) => [e.args.mandateDigest, e.args.status])).toEqual([
      [expired.digest, 2],
      [replayed.digest, 3],
      [badSig.digest, 5],
    ]);
    expect(await balanceOf(f.usdc, accounts.payee.address)).toBe(payeeBefore + AMOUNT);
    expect(await balanceOf(f.usdc, accounts.stranger.address)).toBe(strangerBefore + 70_000n);

    await expect(
      wallets.sp.writeContract({
        address: f.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        functionName: 'settleBatch',
        args: [[tuple(ok1.mandate)], []],
      }),
    ).rejects.toThrow(/LengthMismatch/);
    await assertSolvent();
  });
});
