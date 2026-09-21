import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { DEFAULT_MAX_AUTHORIZATION_VALIDITY, PRINCIPAL, type Caller } from '@agentpay/wallet';
import { KEYS, startStubPayee, type StubPayee } from '../../wallet/test/stub-payee.js';
import { run } from '../src/cli.js';
import { resolveConfig } from '../src/config.js';
import { CommandContext } from '../src/context.js';
import { DEFAULT_BAZAAR_URL, DISCOVERY_NOTE, MAX_DISCOVER_ROWS, compactRow, rankRows } from '../src/bazaar.js';
import { WALLET_TOOLS, createWalletToolHandlers } from '../src/tools.js';
import { SEARCH_FIXTURE, startStubBazaar, type StubBazaar } from './stub-bazaar.js';

type Out = Record<string, any>;
const CHILD: Caller = { kind: 'child', id: 'kid-1', parentSession: 'parent-1' };

// A Base Sepolia wallet: the fixtures are real catalogue rows, and the point is which of them THIS wallet could pay.
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TIMEOUT_MS = 300;

function baseEnv(home: string, bazaar: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    AGENTPAY_HOME: home,
    AGENTPAY_KEY: KEYS.payer,
    AGENTPAY_TOKEN: SEPOLIA_USDC,
    AGENTPAY_TOKEN_NAME: 'USDC',
    AGENTPAY_TOKEN_VERSION: '2',
    AGENTPAY_NETWORK: 'eip155:84532',
    AGENTPAY_BAZAAR_URL: bazaar,
    AGENTPAY_BAZAAR_TIMEOUT_MS: String(TIMEOUT_MS),
    DEPLOYMENT: 'does-not-exist',
  };
}

const RALLY = 'https://api.rallylive.xyz/x402/signals';
const OMNI = 'https://omniterminal.app/api/x402/v1/market-snapshot/:symbol';

describe('discover (CDP Bazaar discovery, filtered to what this wallet can pay)', () => {
  let home: string;
  let bazaar: StubBazaar;
  let payee: StubPayee;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agentpay-discover-'));
    bazaar = await startStubBazaar();
    // A payee that must see nothing: discovery talks to the catalogue only.
    payee = await startStubPayee({
      payTo: privateKeyToAccount(KEYS.payee).address,
      token: SEPOLIA_USDC,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      network: 'eip155:84532',
      price: '$0.001',
      facilitatorAddress: privateKeyToAccount(KEYS.facilitator).address,
    });
    env = baseEnv(home, bazaar.url);
  });

  afterAll(async () => {
    await bazaar.close();
    await payee.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('searches with the wallet network, lists only payable rows, ranked, projected without examples or schemas', async () => {
    bazaar.calls.length = 0;
    const r = await run(['discover', 'market snapshot BTC'], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    // what the catalogue was asked
    expect(bazaar.calls).toHaveLength(1);
    expect(bazaar.calls[0].path).toBe('/discovery/search');
    expect(bazaar.calls[0].params).toEqual({ query: 'market snapshot BTC', network: 'eip155:84532', limit: String(MAX_DISCOVER_ROWS), type: 'http' });
    // the envelope
    expect(out).toMatchObject({ ok: true, query: 'market snapshot BTC', network: 'eip155:84532', bazaar: bazaar.url, matched: 5, payable: 2, partial: true, note: DISCOVERY_NOTE });
    // mainnet-only, upto/permit2 and the 900 s row are gone; the two left are ranked by 30-day payers (rallylive 5 > omniterminal 3)
    expect(out.resources.map((x: Out) => x.resource)).toEqual([RALLY, OMNI]);
    const [rally, omni] = out.resources as Out[];
    expect(rally).toMatchObject({ method: 'POST', service: 'RallyLive', price_usd: '0.010000', network: 'eip155:84532', pay_to: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72', max_timeout_s: 300, payers_30d: 5, calls_30d: 40, last_called: '2026-09-20T18:02:10.500Z' });
    expect(omni).toMatchObject({ method: 'GET', service: 'Omni Terminal', price_usd: '0.005000', payers_30d: 3, calls_30d: 15 });
    // the seller's example request survives, shaped for a model
    expect(omni.input.path.symbol).toBe('BTC');
    expect(omni.input.query.interval).toBe('1h');
    expect(rally.input.body.pairs).toEqual(['BTC-USD', 'ETH-USD']);
    // clamps: description <= 200 (rallylive's is longer and ends with an ellipsis), tags <= 5 x 32
    expect(rally.description.length).toBeLessThanOrEqual(200);
    expect(rally.description.endsWith('…')).toBe(true);
    expect(omni.description).toBe(SEARCH_FIXTURE.resources[0].description);
    expect(rally.tags).toHaveLength(5);
    for (const t of rally.tags) expect(t.length).toBeLessThanOrEqual(32);
    expect(omni.tags).toEqual(['crypto', 'hyperliquid', 'market-data', 'ohlcv']);
    // never the output example, the schema or the icon (the fixture plants markers in each)
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/example|schema|iconUrl|NEVER_REACH|cloudinary/);
    for (const row of out.resources) {
      expect(Object.keys(row).sort()).toEqual(
        ['calls_30d', 'description', 'input', 'last_called', 'last_updated', 'max_timeout_s', 'method', 'network', 'pay_to', 'payers_30d', 'price_usd', 'resource', 'service', 'tags'].sort(),
      );
    }
    expect(payee.requests).toBe(0);
  });

  it('--max-usd is passed to the catalogue and enforced client-side; --limit is clamped to 20 and applied', async () => {
    bazaar.calls.length = 0;
    const cheap = await run(['discover', 'snapshot', '--max-usd', '0.006'], env);
    expect(cheap.code).toBe(0);
    expect(bazaar.calls[0].params.maxUsdPrice).toBe('0.006');
    expect((cheap.output as Out).matched).toBe(5); // the stub does not filter: the client must
    expect((cheap.output as Out).payable).toBe(1);
    expect((cheap.output as Out).resources[0].resource).toBe(OMNI);

    bazaar.calls.length = 0;
    const capped = await run(['discover', 'snapshot', '--limit', '50'], env);
    expect(capped.code).toBe(0);
    expect(bazaar.calls[0].params.limit).toBe('20');
    const one = await run(['discover', 'snapshot', '--limit', '1'], env);
    expect((one.output as Out).resources).toHaveLength(1);
    expect((one.output as Out).resources[0].resource).toBe(RALLY);
    expect((one.output as Out).payable).toBe(1);
    expect((one.output as Out).matched).toBe(5);
  });

  it('--list pages /discovery/resources from --offset, filters the same way and keeps the catalogue order', async () => {
    bazaar.calls.length = 0;
    const r = await run(['discover', '--list', '--offset', '2'], env);
    expect(r.code).toBe(0);
    const out = r.output as Out;
    expect(bazaar.calls[0].path).toBe('/discovery/resources');
    expect(bazaar.calls[0].params.offset).toBe('2');
    // items[2..] of the fixture are rallylive and the upto row: two matched, one payable
    expect(out).toMatchObject({ query: null, matched: 2, payable: 1, partial: false, list: { offset: 2, next_offset: 4, total: 4 } });
    expect(out.resources[0].resource).toBe(RALLY);
    expect(out.resources[0].service).toBeUndefined(); // the raw listing carries no serviceName
    const whole = await run(['discover', '--list'], env);
    expect((whole.output as Out).resources.map((x: Out) => x.resource)).toEqual([OMNI, RALLY]); // catalogue order, not payer rank
    const both = await run(['discover', 'query', '--list'], env);
    expect(both.code).toBe(2);
  });

  it('a 500, a non-JSON body, a slow answer and an unreachable catalogue are all discovery_unavailable (code 1)', async () => {
    bazaar.mode = 'http-500';
    const five = await run(['discover', 'x'], env);
    expect(five.code).toBe(1);
    expect(five.output).toMatchObject({ ok: false, error: 'discovery_unavailable', status: 500, bazaar: bazaar.url });

    bazaar.mode = 'garbage';
    const garbage = await run(['discover', 'x'], env);
    expect(garbage.code).toBe(1);
    expect((garbage.output as Out).error).toBe('discovery_unavailable');
    expect((garbage.output as Out).message).toMatch(/not JSON/);

    bazaar.mode = 'slow';
    const started = Date.now();
    const slow = await run(['discover', 'x'], env);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 10);
    expect(slow.code).toBe(1);
    expect((slow.output as Out).error).toBe('discovery_unavailable');
    expect((slow.output as Out).message).toMatch(new RegExp(`within ${TIMEOUT_MS} ms`));
    expect((slow.output as Out).status).toBeUndefined();
    bazaar.mode = 'ok';

    const gone = await run(['discover', 'x'], { ...env, AGENTPAY_BAZAAR_URL: 'http://127.0.0.1:1' });
    expect(gone.code).toBe(1);
    expect((gone.output as Out).error).toBe('discovery_unavailable');
    expect((gone.output as Out).message).toMatch(/unreachable/);
    // --bazaar beats the env: the same run answers once the flag names the live stub
    const flagged = await run(['discover', 'x', '--bazaar', bazaar.url], { ...env, AGENTPAY_BAZAAR_URL: 'http://127.0.0.1:1' });
    expect(flagged.code).toBe(0);
    expect(payee.requests).toBe(0);
  });

  it('bad arguments and a bad catalogue configuration are usage errors (code 2) that never reach the catalogue', async () => {
    bazaar.calls.length = 0;
    expect((await run(['discover'], env)).code).toBe(2);
    expect((await run(['discover', '   '], env)).code).toBe(2);
    expect((await run(['discover', 'x'.repeat(201)], env)).code).toBe(2);
    expect((await run(['discover', 'x', '--limit', '0'], env)).code).toBe(2);
    expect((await run(['discover', 'x', '--limit', 'ten'], env)).code).toBe(2);
    expect((await run(['discover', 'x', '--max-usd', 'cheap'], env)).code).toBe(2);
    expect((await run(['discover', '--list', '--offset', '-1'], env)).code).toBe(2);
    expect((await run(['discover', 'x', '--bazaar', 'ftp://bazaar.invalid'], env)).code).toBe(2);
    expect((await run(['discover', 'x', '--bazaar', 'not a url'], env)).code).toBe(2);
    expect((await run(['discover', 'x'], { ...env, AGENTPAY_BAZAAR_TIMEOUT_MS: 'soon' })).code).toBe(2);
    expect(bazaar.calls).toHaveLength(0);
    // the default catalogue is the CDP Bazaar
    const cfg = resolveConfig({}, { ...env, AGENTPAY_BAZAAR_URL: undefined, AGENTPAY_BAZAAR_TIMEOUT_MS: undefined });
    expect(cfg.bazaarUrl).toBe(DEFAULT_BAZAAR_URL);
    expect(cfg.bazaarTimeoutMs).toBeUndefined();
  });

  it('wallet_discover: a read tool any session may call, the same envelope, bad arguments code 2', async () => {
    const tool = WALLET_TOOLS.find((t) => t.name === 'wallet_discover')!;
    expect(tool.kind).toBe('read');
    expect(tool.principalOnly).toBe(false);
    expect((tool.parameters as Out).properties.query).toMatchObject({ type: 'string', minLength: 1, maxLength: 200 });
    expect((tool.parameters as Out).properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 20 });
    expect((tool.parameters as Out).required).toEqual(['query']);
    expect(tool.description).toMatch(/wallet_offer/);

    const config = resolveConfig({}, env);
    const ctx = new CommandContext(config, globalThis.fetch, () => {}, { requireMandateHost: true });
    const call = createWalletToolHandlers(ctx);
    try {
      bazaar.calls.length = 0;
      const r = await call('wallet_discover', { query: 'daily bars', max_usd: '0.05', limit: 5 }, { caller: CHILD });
      expect(r.code).toBe(0);
      const out = r.output as Out;
      expect(Object.keys(out).sort()).toEqual(['ok', 'query', 'network', 'bazaar', 'matched', 'payable', 'partial', 'resources', 'note'].sort());
      expect(out).toMatchObject({ query: 'daily bars', network: 'eip155:84532', matched: 5, payable: 2 });
      expect(bazaar.calls[0].params).toMatchObject({ query: 'daily bars', maxUsdPrice: '0.05', limit: '5', network: 'eip155:84532' });
      expect(JSON.stringify(out)).not.toMatch(/example|schema|iconUrl/);
      const asPrincipal = await call('wallet_discover', { query: 'daily bars' }, { caller: PRINCIPAL });
      expect(asPrincipal.code).toBe(0);

      bazaar.calls.length = 0;
      for (const args of [{}, { query: '' }, { query: 'x', limit: 21 }, { query: 'x', limit: 1.5 }, { query: 'x', limit: '5' }, { query: 'x', max_usd: 'ten' }, { query: 'x', nope: 1 }, { query: 'x'.repeat(201) }]) {
        const bad = await call('wallet_discover', args, { caller: CHILD });
        expect(bad.code, JSON.stringify(args)).toBe(2);
      }
      expect(bazaar.calls).toHaveLength(0);

      bazaar.mode = 'http-500';
      const down = await call('wallet_discover', { query: 'x' }, { caller: CHILD });
      expect(down.code).toBe(1);
      expect((down.output as Out).error).toBe('discovery_unavailable');
      bazaar.mode = 'ok';
    } finally {
      ctx.dispose();
    }
    expect(payee.requests).toBe(0);
  });

  it('compactRow applies the wallet predicate and the validity cap; rankRows orders payers, calls, recency', () => {
    const scope = { network: 'eip155:84532', token: SEPOLIA_USDC, assetDomain: { name: 'USDC', version: '2' } };
    const [omni, , mainnetOnly, upto, slow] = SEARCH_FIXTURE.resources;
    expect(compactRow(omni, scope)?.network).toBe('eip155:84532'); // the first payable accept of a dual-network row
    expect(compactRow(mainnetOnly, scope)).toBeUndefined();
    expect(compactRow(upto, scope)).toBeUndefined();
    expect(compactRow(slow, scope)).toBeUndefined(); // 900 s > DEFAULT_MAX_AUTHORIZATION_VALIDITY
    expect(compactRow(slow, { ...scope, maxTimeoutSeconds: 900 })?.price_usd).toBe('0.001000');
    expect(DEFAULT_MAX_AUTHORIZATION_VALIDITY).toBe(300);
    // on the mainnet wallet's terms the mainnet row is payable and the testnet-only one is not
    const mainnet = { network: 'eip155:8453', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', assetDomain: { name: 'USD Coin', version: '2' } };
    expect(compactRow(mainnetOnly, mainnet)?.price_usd).toBe('0.010000');
    expect(compactRow(SEARCH_FIXTURE.resources[1], mainnet)).toBeUndefined();
    // not https, or no accepts: not payable
    expect(compactRow({ ...omni, resource: 'http://omniterminal.app/x' }, scope)).toBeUndefined();
    expect(compactRow({ ...omni, accepts: [] }, scope)).toBeUndefined();
    // a huge example input is cut to 500 characters of JSON, flagged
    const bulky = { ...omni, extensions: { bazaar: { info: { input: { method: 'GET', queryParams: { blob: 'y'.repeat(2000) }, type: 'http' } } } } };
    const cut = compactRow(bulky, scope)!;
    expect(typeof cut.input).toBe('string');
    expect((cut.input as string).length).toBe(500);
    expect(cut.input_truncated).toBe(true);

    const row = (over: Partial<ReturnType<typeof compactRow>>) => ({ ...compactRow(omni, scope)!, ...over });
    const ranked = rankRows([
      row({ resource: 'c', payers_30d: 1, calls_30d: 9, last_called: '2026-09-01T00:00:00Z' }),
      row({ resource: 'd', payers_30d: 1, calls_30d: 9, last_called: '2026-09-02T00:00:00Z' }),
      row({ resource: 'b', payers_30d: 1, calls_30d: 10 }),
      row({ resource: 'a', payers_30d: 2, calls_30d: 0 }),
    ]);
    expect(ranked.map((x) => x.resource)).toEqual(['a', 'b', 'd', 'c']);
  });
});
