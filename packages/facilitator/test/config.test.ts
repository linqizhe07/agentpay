import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { MOCK_USDC_DOMAIN, deploymentPath } from '@agentpay/contracts';
import { FACILITATOR_DEFAULTS, loadConfigFromEnv, resolveConfig, type FacilitatorConfig } from '../src/index.js';
import { KEYS, accounts, extraAccount, fixture, mkFacilitator, rpcProxy } from './helpers.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function base(): FacilitatorConfig {
  return { rpcUrl: 'http://127.0.0.1:8545', chainId: 84532, key: KEYS.facilitator, tokens: [USDC], port: 0 };
}

describe('config', () => {
  it('loads from env, with the deployment record filling what is unset', () => {
    const cfg = loadConfigFromEnv({ FACILITATOR_PK: KEYS.facilitator, DEPLOYMENT: 'base-sepolia', PAYEES: `${accounts.payee.address},${accounts.stranger.address}` });
    expect(cfg.chainId).toBe(84532);
    expect(cfg.tokens).toEqual([USDC]);
    expect(cfg.assetDomain).toEqual({ name: 'USDC', version: '2' });
    expect(cfg.payees).toEqual([accounts.payee.address, accounts.stranger.address]);
    expect(cfg.port).toBe(FACILITATOR_DEFAULTS.port);
    expect(cfg.rpcUrl).toBe(FACILITATOR_DEFAULTS.rpcUrl);
  });

  it('explicit env wins over the record; a record path works too', () => {
    const cfg = loadConfigFromEnv({
      FACILITATOR_PK: KEYS.facilitator,
      DEPLOYMENT: deploymentPath('base-sepolia'),
      CHAIN_ID: '31337',
      SUPPORTED_TOKENS: accounts.stranger.address.toLowerCase(),
      USDC_DOMAIN_NAME: 'Mock USD Coin',
      USDC_DOMAIN_VERSION: '2',
      FACILITATOR_PORT: '0',
      RECEIPT_TIMEOUT_MS: '1234',
      FACILITATOR_AUTH_TOKEN: 'tok',
      RPC_URL: 'http://127.0.0.1:9999',
    });
    expect(cfg.chainId).toBe(31337);
    expect(cfg.tokens).toEqual([getAddress(accounts.stranger.address)]);
    expect(cfg.assetDomain).toEqual(MOCK_USDC_DOMAIN);
    expect(cfg.port).toBe(0);
    expect(cfg.receiptTimeoutMs).toBe(1234);
    expect(cfg.authToken).toBe('tok');
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:9999');
  });

  it('requires FACILITATOR_PK and integer env values', () => {
    expect(() => loadConfigFromEnv({})).toThrow(/FACILITATOR_PK/);
    expect(() => loadConfigFromEnv({ FACILITATOR_PK: KEYS.facilitator, DEPLOYMENT: 'base-sepolia', FACILITATOR_PORT: 'x' })).toThrow(/FACILITATOR_PORT/);
  });

  it('resolveConfig applies defaults and validates', () => {
    const r = resolveConfig(base());
    expect(r.network).toBe('eip155:84532');
    expect(r.host).toBe('127.0.0.1');
    expect(r.receiptTimeoutMs).toBe(30_000);
    expect(r.pollingIntervalMs).toBe(500);
    expect(r.payees).toBeUndefined();
    expect(() => resolveConfig({ ...base(), key: '0x12' })).toThrow(/private key/);
    expect(() => resolveConfig({ ...base(), rpcUrl: 'ws://x' })).toThrow(/rpcUrl/);
    expect(() => resolveConfig({ ...base(), tokens: [] })).toThrow(/tokens/);
    expect(() => resolveConfig({ ...base(), tokens: ['0xnope'] })).toThrow(/tokens\[0\]/);
    expect(() => resolveConfig({ ...base(), payees: ['0xnope'] })).toThrow(/payees\[0\]/);
    expect(() => resolveConfig({ ...base(), chainId: 0 })).toThrow(/chainId/);
    expect(() => resolveConfig({ ...base(), receiptTimeoutMs: 0 })).toThrow(/receiptTimeoutMs/);
    expect(() => resolveConfig({ ...base(), authToken: '' })).toThrow(/authToken/);
  });
});

describe('startup', () => {
  it('refuses a chain-id mismatch', async () => {
    const fac = mkFacilitator({ chainId: 84532 });
    await expect(fac.start()).rejects.toThrow(/serves chain 31337/);
  });

  it('refuses a token that is not EIP-3009', async () => {
    const fac = mkFacilitator({ tokens: [accounts.stranger.address], assetDomain: undefined });
    await expect(fac.start()).rejects.toThrow(/not an EIP-3009/);
  });

  it('refuses a wrong asset domain instead of failing every signature later', async () => {
    const fac = mkFacilitator({ assetDomain: { name: 'USDC', version: '2' } });
    await expect(fac.start()).rejects.toThrow(/does not sign under/);
  });

  it('refuses a signer without ETH', async () => {
    // Hardhat's dev accounts all hold ETH; a random key holds none.
    const fac = mkFacilitator({ key: '0x1111111111111111111111111111111111111111111111111111111111111111' });
    await expect(fac.start()).rejects.toThrow(/no ETH/);
  });

  it('refuses an unreachable RPC', async () => {
    const proxy = await rpcProxy(fixture().rpcUrl);
    proxy.dead = true;
    const fac = mkFacilitator({ rpcUrl: proxy.url });
    try {
      await expect(fac.start()).rejects.toThrow(/cannot reach RPC/);
    } finally {
      await proxy.close();
    }
  });

  it('extraAccount yields funded hardhat accounts for the tests above', () => {
    expect(extraAccount(11).address).toMatch(/^0x/);
  });
});
