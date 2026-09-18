import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEMORY_STORE_PATH, SP_DEFAULTS, loadConfigFromEnv, resolveConfig, type SPConfig } from '../src/index.js';
import { KEYS } from './helpers.js';

const WALLET = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const USDC = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
/** The durable default lives next to the package, not in the caller's cwd (.gitignore lists it). */
const DEFAULT_STORE = fileURLToPath(new URL('../data/sp-queue.jsonl', import.meta.url));

describe('loadConfigFromEnv', () => {
  it('reads every variable', () => {
    const cfg = loadConfigFromEnv({
      SP_PK: KEYS.sp,
      RPC_URL: 'http://127.0.0.1:9999',
      CHAIN_ID: '84532',
      WALLET_ADDRESS: WALLET,
      SUPPORTED_TOKENS: `${USDC}, ${WALLET}`,
      SP_PORT: '0',
      STORE_PATH: '/tmp/x.jsonl',
      SETTLE_WINDOW: '600',
      MIN_DEADLINE_MARGIN: '10',
      MAX_DEADLINE_HORIZON: '7200',
      BATCH_INTERVAL_MS: '0',
      BATCH_MAX: '5',
      SEND_MARGIN: '15',
      MAX_ATTEMPTS: '3',
    });
    expect(cfg).toMatchObject({
      rpcUrl: 'http://127.0.0.1:9999',
      chainId: 84532,
      key: KEYS.sp,
      wallet: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      tokens: ['0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', '0x5FbDB2315678afecb367f032d93F642f64180aa3'],
      port: 0,
      storePath: '/tmp/x.jsonl',
      settleWindowSeconds: 600,
      minDeadlineMarginSeconds: 10,
      maxDeadlineHorizonSeconds: 7200,
      batchIntervalMs: 0,
      batchMax: 5,
      sendMarginSeconds: 15,
      maxAttempts: 3,
    });
  });

  it('falls back to the deployment record for chain, wallet and token', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentpay-dep-'));
    const file = path.join(dir, 'custom.json');
    writeFileSync(
      file,
      JSON.stringify({
        chainId: 31337,
        network: 'eip155:31337',
        wallet: WALLET,
        usdc: USDC,
        withdrawDelay: 600,
        deployer: WALLET,
        txHash: `0x${'00'.repeat(32)}`,
        blockNumber: 1,
        deployedAt: 'now',
      }),
    );
    const cfg = loadConfigFromEnv({ SP_PK: KEYS.sp, DEPLOYMENT: file });
    expect(cfg.chainId).toBe(31337);
    expect(cfg.wallet.toLowerCase()).toBe(WALLET);
    expect(cfg.tokens.map((t) => t.toLowerCase())).toEqual([USDC]);
    expect(cfg.port).toBe(SP_DEFAULTS.port);
    expect(cfg.rpcUrl).toBe(SP_DEFAULTS.rpcUrl);
    expect(cfg.storePath).toBe(DEFAULT_STORE);
    // explicit values win over the record
    const mixed = loadConfigFromEnv({ SP_PK: KEYS.sp, DEPLOYMENT: file, CHAIN_ID: '1', SUPPORTED_TOKENS: WALLET });
    expect(mixed.chainId).toBe(1);
    expect(mixed.tokens.map((t) => t.toLowerCase())).toEqual([WALLET]);
    expect(mixed.wallet.toLowerCase()).toBe(WALLET);
  });

  it('STORE_PATH: unset or blank is the package data file, :memory: opts out, anything else is taken as given', () => {
    const base = { SP_PK: KEYS.sp, CHAIN_ID: '31337', WALLET_ADDRESS: WALLET, SUPPORTED_TOKENS: USDC };
    expect(loadConfigFromEnv(base).storePath).toBe(DEFAULT_STORE);
    expect(loadConfigFromEnv({ ...base, STORE_PATH: '  ' }).storePath).toBe(DEFAULT_STORE);
    expect(loadConfigFromEnv({ ...base, STORE_PATH: ':memory:' }).storePath).toBe(MEMORY_STORE_PATH);
    expect(loadConfigFromEnv({ ...base, STORE_PATH: ' ./data/q.jsonl ' }).storePath).toBe('./data/q.jsonl');
    expect(SP_DEFAULTS.storePath).toBe(DEFAULT_STORE);
  });

  it('rejects a missing key, a missing deployment and non-integer numbers', () => {
    expect(() => loadConfigFromEnv({})).toThrow(/SP_PK/);
    expect(() => loadConfigFromEnv({ SP_PK: '0x1234' })).toThrow(/SP_PK/);
    expect(() => loadConfigFromEnv({ SP_PK: KEYS.sp, DEPLOYMENT: '/nonexistent/dep.json' })).toThrow(/no deployment record/);
    expect(() =>
      loadConfigFromEnv({ SP_PK: KEYS.sp, CHAIN_ID: '31337', WALLET_ADDRESS: WALLET, SUPPORTED_TOKENS: USDC, BATCH_MAX: 'ten' }),
    ).toThrow(/BATCH_MAX/);
  });
});

describe('resolveConfig', () => {
  const base: SPConfig = { rpcUrl: 'http://127.0.0.1:8545', chainId: 31337, key: KEYS.sp, wallet: WALLET, tokens: [USDC], port: 0 };

  it('applies defaults and checksums addresses', () => {
    const r = resolveConfig({ ...base });
    expect(r).toMatchObject({
      settleWindowSeconds: SP_DEFAULTS.settleWindowSeconds,
      minDeadlineMarginSeconds: SP_DEFAULTS.minDeadlineMarginSeconds,
      maxDeadlineHorizonSeconds: SP_DEFAULTS.maxDeadlineHorizonSeconds,
      batchIntervalMs: SP_DEFAULTS.batchIntervalMs,
      batchMax: SP_DEFAULTS.batchMax,
      sendMarginSeconds: SP_DEFAULTS.sendMarginSeconds,
      maxAttempts: SP_DEFAULTS.maxAttempts,
      host: SP_DEFAULTS.host,
      pollingIntervalMs: SP_DEFAULTS.pollingIntervalMs,
      wallet: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      tokens: ['0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'],
    });
    expect(r.storePath).toBe(DEFAULT_STORE);
    expect(typeof r.clock()).toBe('number');
    expect(typeof r.log).toBe('function');
  });

  it('resolves storePath by the same rule as the env loader', () => {
    expect(resolveConfig({ ...base, storePath: '' }).storePath).toBe(DEFAULT_STORE);
    expect(resolveConfig({ ...base, storePath: MEMORY_STORE_PATH }).storePath).toBe(MEMORY_STORE_PATH);
    expect(resolveConfig({ ...base, storePath: '/tmp/q.jsonl' }).storePath).toBe('/tmp/q.jsonl');
  });

  it('validates the inputs', () => {
    expect(() => resolveConfig({ ...base, key: '0xbad' })).toThrow(/config.key/);
    expect(() => resolveConfig({ ...base, rpcUrl: 'ws://x' })).toThrow(/rpcUrl/);
    expect(() => resolveConfig({ ...base, chainId: 0 })).toThrow(/chainId/);
    expect(() => resolveConfig({ ...base, wallet: '0x12' })).toThrow(/wallet/);
    expect(() => resolveConfig({ ...base, tokens: [] })).toThrow(/tokens/);
    expect(() => resolveConfig({ ...base, port: -1 })).toThrow(/port/);
    expect(() => resolveConfig({ ...base, batchMax: 0 })).toThrow(/batchMax/);
    expect(() => resolveConfig({ ...base, settleWindowSeconds: 1.5 })).toThrow(/settleWindowSeconds/);
    expect(() => resolveConfig({ ...base, minDeadlineMarginSeconds: 100, maxDeadlineHorizonSeconds: 50 })).toThrow(
      /minDeadlineMarginSeconds/,
    );
  });
});
