import { beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { MOCK_USDC_ABI } from '../src/index.js';
import { accounts, balanceOf, deployFixture, publicClient, wallets } from './helpers.js';

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
    expect(name).toBe('Mock USD Coin');
    expect(symbol).toBe('USDC');
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

  it('approve + transferFrom works like a plain ERC-20 (what the debit wallet relies on)', async () => {
    const approve = await wallets.payer.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'approve',
      args: [accounts.payee.address, 500n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });
    const before = await balanceOf(usdc, accounts.payee.address);
    const pull = await wallets.payee.writeContract({
      address: usdc,
      abi: MOCK_USDC_ABI,
      functionName: 'transferFrom',
      args: [accounts.payer.address, accounts.payee.address, 500n],
    });
    await publicClient.waitForTransactionReceipt({ hash: pull });
    expect(await balanceOf(usdc, accounts.payee.address)).toBe(before + 500n);
  });
});
