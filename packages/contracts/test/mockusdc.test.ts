import { beforeAll, describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, domainSeparator, parseEventLogs, type Address } from 'viem';
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN, MULTICALL3_ADDRESS } from '../src/index.js';
import {
  AMOUNT,
  CHAIN_ID,
  accounts,
  authorizationState,
  balanceOf,
  deployFixture,
  makeAuthorization,
  now,
  publicClient,
  signAuthorization,
  transferWithAuthorization,
  wallets,
} from './helpers.js';

/** The custom error name a viem write rejected with, or the raw message when it is not a revert. */
async function revertName(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no revert';
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? 'revert';
    return err instanceof Error ? err.message : String(err);
  }
}

describe('MockUSDC (test token)', () => {
  let usdc: Address;

  beforeAll(async () => {
    ({ usdc } = await deployFixture());
  });

  it('has USDC metadata: 6 decimals, name matching the EIP-712 domain', async () => {
    const [decimals, name, symbol] = await Promise.all([
      publicClient.readContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'decimals' }),
      publicClient.readContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'name' }),
      publicClient.readContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'symbol' }),
    ]);
    expect(decimals).toBe(6);
    expect(name).toBe(MOCK_USDC_DOMAIN.name);
    expect(symbol).toBe('USDC');
  });

  it('exposes its EIP-712 domain (ERC-5267) and it matches MOCK_USDC_DOMAIN', async () => {
    const [, name, version, chainId, verifyingContract] = await publicClient.readContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'eip712Domain',
    });
    expect({ name, version, chainId: Number(chainId), verifyingContract: verifyingContract.toLowerCase() }).toEqual({
      ...MOCK_USDC_DOMAIN,
      chainId: CHAIN_ID,
      verifyingContract: usdc.toLowerCase(),
    });
    // The same inputs viem hashes for a signature; a mismatch here would make every signature invalid.
    expect(domainSeparator({ domain: { name, version, chainId: Number(chainId), verifyingContract } })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('mint is open to anyone (test token)', async () => {
    const before = await balanceOf(usdc, accounts.stranger.address);
    const hash = await wallets.stranger.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'mint',
      args: [accounts.stranger.address, 123n],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await balanceOf(usdc, accounts.stranger.address)).toBe(before + 123n);
  });

  it('deployLocalFixture installs Multicall3 at its canonical address', async () => {
    const code = await publicClient.getCode({ address: MULTICALL3_ADDRESS });
    expect(code && code.length > 2).toBe(true);
  });

  describe('transferWithAuthorization (EIP-3009)', () => {
    it('lets anyone relay a payer-signed authorization: value moves, nonce is marked used', async () => {
      const auth = await makeAuthorization();
      const sig = await signAuthorization(usdc, auth);
      const payerBefore = await balanceOf(usdc, auth.from);
      const payeeBefore = await balanceOf(usdc, auth.to);
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(false);

      // The facilitator (not payer, not payee) submits the transfer and pays gas.
      const receipt = await transferWithAuthorization(usdc, 'facilitator', auth, sig);
      expect(receipt.status).toBe('success');
      const used = parseEventLogs({ abi: MOCK_USDC_ABI, eventName: 'AuthorizationUsed', logs: receipt.logs });
      expect(used).toHaveLength(1);
      expect(used[0]!.args).toEqual({ authorizer: auth.from, nonce: auth.nonce });
      const transfers = parseEventLogs({ abi: MOCK_USDC_ABI, eventName: 'Transfer', logs: receipt.logs });
      expect(transfers[0]!.args).toEqual({ from: auth.from, to: auth.to, value: AMOUNT });

      expect(await balanceOf(usdc, auth.from)).toBe(payerBefore - AMOUNT);
      expect(await balanceOf(usdc, auth.to)).toBe(payeeBefore + AMOUNT);
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(true);
    });

    it('rejects a replay of the same authorization', async () => {
      const auth = await makeAuthorization();
      const sig = await signAuthorization(usdc, auth);
      await transferWithAuthorization(usdc, 'facilitator', auth, sig);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', auth, sig))).toBe('AuthorizationAlreadyUsed');
    });

    it('rejects an expired authorization and leaves the nonce unused', async () => {
      const t = await now();
      const auth = await makeAuthorization({ validBefore: BigInt(t) }); // block.timestamp >= validBefore
      const sig = await signAuthorization(usdc, auth);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', auth, sig))).toBe('AuthorizationExpired');
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(false);
    });

    it('rejects an authorization that is not yet valid', async () => {
      const t = await now();
      const auth = await makeAuthorization({ validAfter: BigInt(t + 3600) });
      const sig = await signAuthorization(usdc, auth);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', auth, sig))).toBe('AuthorizationNotYetValid');
    });

    it('rejects a signature from anyone but `from`', async () => {
      const auth = await makeAuthorization();
      const sig = await signAuthorization(usdc, auth, accounts.stranger);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', auth, sig))).toBe('InvalidSignature');
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(false);
    });

    it('rejects a tampered value (the signature covers every field)', async () => {
      const auth = await makeAuthorization();
      const sig = await signAuthorization(usdc, auth);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', { ...auth, value: auth.value + 1n }, sig))).toBe(
        'InvalidSignature',
      );
    });

    it('reverts whole when the payer cannot cover the value, keeping the nonce unused', async () => {
      const balance = await balanceOf(usdc, accounts.payer.address);
      const auth = await makeAuthorization({ value: balance + 1n });
      const sig = await signAuthorization(usdc, auth);
      expect(await revertName(transferWithAuthorization(usdc, 'facilitator', auth, sig))).toBe('ERC20InsufficientBalance');
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(false);
    });

    it('receiveWithAuthorization only works when the payee itself submits it', async () => {
      const auth = await makeAuthorization();
      const signature = await accounts.payer.signTypedData({
        domain: { ...MOCK_USDC_DOMAIN, chainId: CHAIN_ID, verifyingContract: usdc },
        types: {
          ReceiveWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'ReceiveWithAuthorization',
        message: auth,
      });
      const r = `0x${signature.slice(2, 66)}` as const;
      const s = `0x${signature.slice(66, 130)}` as const;
      const v = Number.parseInt(signature.slice(130, 132), 16);
      const args = [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s] as const;

      const relayed = wallets.facilitator.writeContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'receiveWithAuthorization', args });
      expect(await revertName(relayed)).toBe('CallerMustBePayee');

      const hash = await wallets.payee.writeContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'receiveWithAuthorization', args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      expect(await authorizationState(usdc, auth.from, auth.nonce)).toBe(true);
    });
  });
});
