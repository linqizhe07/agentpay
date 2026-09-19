import { describe, expect, it } from 'vitest';
import {
  EIP3009_ABI,
  HINT_REASONS,
  OUTCOME_REASONS,
  PAYEE_REASONS,
  POLICY_REASONS,
  WireError,
  chainIdFromNetwork,
  formatUsdc,
  networkFromChainId,
  parseAmount,
  parsePrice,
  paymentModelContext,
  randomBytes32,
} from '../src/index.js';

describe('money', () => {
  it('parses prices to 6dp atomic units', () => {
    expect(parsePrice('$0.01')).toBe(10000n);
    expect(parsePrice('0.001')).toBe(1000n);
    expect(parsePrice('$1')).toBe(1_000_000n);
    expect(parsePrice('$12.345678')).toBe(12_345_678n);
  });
  it('rejects garbage, zero, and absurd prices', () => {
    for (const bad of ['', 'abc', '$0', '0', '-1', '$0.0000001', '$1001']) {
      expect(() => parsePrice(bad), bad).toThrow(WireError);
    }
  });
  it('parseAmount accepts prices and bare atomic units', () => {
    expect(parseAmount('$1.50')).toBe(1_500_000n);
    expect(parseAmount('1500000')).toBe(1_500_000n);
    expect(parseAmount('0.5')).toBe(500_000n);
  });
  it('formats atomic units', () => {
    expect(formatUsdc(10000n)).toBe('$0.010000');
    expect(formatUsdc(-1_500_000n)).toBe('-$1.500000');
  });
  it('parses CAIP-2 eip155 networks', () => {
    expect(chainIdFromNetwork('eip155:84532')).toBe(84532);
    expect(networkFromChainId(31337)).toBe('eip155:31337');
    expect(() => chainIdFromNetwork('solana:mainnet')).toThrow(WireError);
  });
});

describe('ids', () => {
  it('randomBytes32 yields distinct 32-byte hex nonces (the EIP-3009 nonce format)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = randomBytes32();
      expect(n).toMatch(/^0x[0-9a-f]{64}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(50);
  });
});

describe('eip3009 abi', () => {
  it('names the reads and events the wallet reconciles with', () => {
    const names = EIP3009_ABI.map((item) => ('name' in item ? item.name : ''));
    expect(names).toEqual(expect.arrayContaining(['balanceOf', 'authorizationState', 'AuthorizationUsed', 'Transfer']));
  });
});

describe('hints', () => {
  it('covers every policy, payee and outcome reason', () => {
    for (const reason of [...POLICY_REASONS, ...PAYEE_REASONS, ...OUTCOME_REASONS]) {
      expect(HINT_REASONS, reason).toContain(reason);
      const ctx = paymentModelContext(reason, { amount: '1000', remaining: '0' });
      expect(ctx.protocol).toBe('x402');
      expect(ctx.reason).toBe(reason);
      expect(ctx.summary.length).toBeGreaterThan(10);
      expect(ctx.remediation.length).toBeGreaterThan(0);
    }
  });
  it('tells the agent to reconcile before paying again when the outcome is unknown', () => {
    expect(paymentModelContext('unknown').commands).toContain('agentpay reconcile');
    expect(paymentModelContext('invalid_exact_evm_nonce_already_used').commands).toContain('agentpay reconcile');
  });
  it('falls back to a generic hint for unknown reasons', () => {
    const ctx = paymentModelContext('something_new');
    expect(ctx.reason).toBe('something_new');
    expect(ctx.remediation.length).toBe(1);
  });
});
