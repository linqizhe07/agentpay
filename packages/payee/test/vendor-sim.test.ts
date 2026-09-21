import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { MOCK_USDC_DOMAIN } from '@agentpay/contracts';
import { createPaywall, type Paywall } from '../src/index.js';
import { AGGS_TEMPLATE, NEWS_TEMPLATE, createVendorSimApp } from '../examples/vendor-sim/app.js';
import { PATH_START, dailyBars, fnv1a, mulberry32, newsFor, parseIsoDay, resetPaths } from '../examples/vendor-sim/data.js';
import { accounts, closeServer, getOffer, listen, pay, paymentFor, readSettlement } from './helpers.js';
import { startStubFacilitator, type StubFacilitator } from './stub-facilitator.js';

// Offline suite: the vendor simulator behind a paywall on a stub facilitator.
const NETWORK = 'eip155:31337';
const USDC = '0x2000000000000000000000000000000000000002' as const;
const TODAY = new Date('2026-09-01T13:00:00Z');

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  n: number;
}
interface AggsBody {
  ticker: string;
  queryCount: number;
  resultsCount: number;
  adjusted: boolean;
  results: Bar[];
  status: string;
  request_id: string;
  count: number;
}

const keyOf = (payload: { payload: unknown }): string => {
  const a = (payload.payload as { authorization: { from: string; nonce: string } }).authorization;
  return `${a.from}:${a.nonce}`.toLowerCase();
};

describe('vendor-sim data (deterministic generator)', () => {
  afterEach(() => resetPaths());

  it('hashes and seeds the way the plan says (FNV-1a, mulberry32)', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    const r = mulberry32(1);
    const first = [r(), r(), r()];
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    const again = mulberry32(1);
    expect([again(), again(), again()]).toEqual(first);
  });

  it('parses strict calendar days only', () => {
    expect(parseIsoDay('2019-03-04')).toBe(Date.UTC(2019, 2, 4));
    for (const bad of ['2019-3-4', '2019-02-30', '20190304', '2019-03-04T00:00:00Z', 'yesterday', '']) expect(parseIsoDay(bad), bad).toBeUndefined();
  });

  it('gives the same bar for (AAPL, 2019-03-04) whichever way it is reached, and a different one for MSFT', () => {
    const direct = dailyBars('AAPL', Date.UTC(2019, 2, 4), Date.UTC(2019, 2, 4));
    expect(direct).toHaveLength(1);
    resetPaths();
    const viaLongerRange = dailyBars('AAPL', Date.UTC(2018, 0, 1), Date.UTC(2020, 0, 1)).find((b) => b.t === direct[0]!.t);
    expect(viaLongerRange).toEqual(direct[0]);
    expect(direct[0]!.t).toBe(Date.UTC(2019, 2, 4, 5)); // 05:00 UTC = midnight ET
    const msft = dailyBars('MSFT', Date.UTC(2019, 2, 4), Date.UTC(2019, 2, 4));
    expect(msft[0]!.c).not.toBe(direct[0]!.c);
  });

  it('skips weekends, starts at 2000-01-03 and keeps a sane bar', () => {
    expect(PATH_START).toBe(Date.UTC(2000, 0, 3));
    expect(new Date(PATH_START).getUTCDay()).toBe(1); // Monday
    expect(dailyBars('AAPL', Date.UTC(1999, 11, 20), Date.UTC(2000, 0, 2))).toEqual([]);
    expect(dailyBars('AAPL', Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 3))).toHaveLength(1);
    expect(dailyBars('AAPL', Date.UTC(2019, 2, 9), Date.UTC(2019, 2, 10))).toEqual([]); // Sat, Sun
    expect(dailyBars('AAPL', Date.UTC(2019, 2, 6), Date.UTC(2019, 2, 5))).toEqual([]); // to < from
    const year = dailyBars('AAPL', Date.UTC(2016, 0, 1), Date.UTC(2016, 11, 31));
    expect(year).toHaveLength(261); // 2016 has 261 weekdays; no holidays modelled
    for (const b of year) {
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
      expect(Math.max(b.o, b.c)).toBeLessThanOrEqual(b.h);
      expect(b.vw).toBeGreaterThanOrEqual(b.l);
      expect(b.vw).toBeLessThanOrEqual(b.h);
      expect(b.v).toBeGreaterThan(0);
      expect(Number.isInteger(b.v) && Number.isInteger(b.n)).toBe(true);
      for (const k of ['o', 'h', 'l', 'c', 'vw'] as const) expect(Math.round(b[k] * 10_000) / 10_000).toBe(b[k]);
      expect(new Date(b.t).getUTCHours()).toBe(5);
    }
    for (let i = 1; i < year.length; i++) expect(year[i]!.t).toBeGreaterThan(year[i - 1]!.t);
    expect(JSON.stringify(year).length).toBeGreaterThan(8192); // a year does not fit wallet_pay's inline body
  });

  it('news: templated items a day apart from today, deterministic ids under sim.invalid', () => {
    const a = newsFor('AAPL', 3, TODAY);
    expect(a).toHaveLength(3);
    expect(a.map((n) => n.published_utc)).toEqual(['2026-09-01T13:00:00Z', '2026-08-31T13:00:00Z', '2026-08-30T13:00:00Z']);
    for (const n of a) {
      expect(n.article_url).toBe(`https://sim.invalid/news/${n.id}`);
      expect(n.id).toMatch(/^[0-9a-f]{16}$/);
      expect(n.tickers).toEqual(['AAPL']);
      expect(n.title).toContain('AAPL');
    }
    expect(newsFor('AAPL', 3, TODAY)).toEqual(a);
    expect(newsFor('MSFT', 1, TODAY)[0]!.id).not.toBe(a[0]!.id);
    expect(newsFor('AAPL', 5, new Date('2026-09-02T13:00:00Z'))[1]!.published_utc).toBe('2026-09-01T13:00:00Z');
  });
});

describe('vendor-sim app (offline, stub facilitator)', () => {
  let facilitator: StubFacilitator;
  let paywall: Paywall;
  let server: Server;
  let base: string;

  const aggsUrl = (ticker: string, from: string, to: string, query = '') => `${base}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}${query}`;

  const buy = async (url: string): Promise<{ res: Response; body: any; key: string }> => {
    const { required } = await getOffer(url);
    const payload = await paymentFor(required);
    const res = await pay(url, payload);
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : undefined, key: keyOf(payload) };
  };

  beforeAll(async () => {
    facilitator = await startStubFacilitator({ network: NETWORK, address: accounts.facilitator.address });
    paywall = createPaywall({
      facilitator: { url: facilitator.url, timeoutMs: 500 },
      network: NETWORK,
      asset: USDC,
      assetDomain: { ...MOCK_USDC_DOMAIN },
      payTo: accounts.payee.address,
      log: () => {},
    });
    ({ server, base } = await listen(createVendorSimApp(paywall, { today: TODAY })));
  });

  afterAll(async () => {
    await closeServer(server);
    await facilitator.close();
  });

  afterEach(() => {
    facilitator.mode = { kind: 'ok' };
    facilitator.calls.length = 0;
  });

  it('GET /health is free and lists the routes with their prices', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; routes: Array<{ path: string; price: string | null }> };
    expect(body.ok).toBe(true);
    expect(body.routes.map((r) => [r.path, r.price])).toEqual([
      ['/health', null],
      [AGGS_TEMPLATE, '$0.01'],
      [NEWS_TEMPLATE, '$0.01'],
    ]);
    expect(facilitator.calls).toHaveLength(0);
  });

  it('402 on aggregates: $0.01, and a bazaar declaration with the exact route template, under 4 KB', async () => {
    const { res, required } = await getOffer(aggsUrl('AAPL', '2019-03-04', '2019-03-08', '?adjusted=false&sort=asc&limit=50000'));
    expect(res.status).toBe(402);
    expect(required.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, amount: '10000', payTo: accounts.payee.address });
    expect(required.resource.description).toMatch(/OHLCV/);
    const extensions = (required as { extensions?: Record<string, any> }).extensions!;
    expect(extensions.bazaar.routeTemplate).toBe('/v2/aggs/ticker/:ticker/range/1/day/:from/:to');
    expect(extensions.bazaar.info.input).toMatchObject({
      type: 'http',
      method: 'GET',
      pathParams: { ticker: 'AAPL', from: '2019-03-04', to: '2019-03-05' },
      queryParams: { adjusted: 'true', sort: 'asc', limit: '50000' },
    });
    expect(extensions.bazaar.info.output.example.results).toHaveLength(2);
    expect(JSON.stringify(extensions).length).toBeLessThan(4096);
    // The example's bars are the simulator's own: what a catalogue shows is what a buyer gets.
    expect(dailyBars('AAPL', Date.UTC(2019, 2, 4), Date.UTC(2019, 2, 5))).toEqual(extensions.bazaar.info.output.example.results);
  });

  it('both declarations pass @x402/express\'s async bazaar validation (no "invalid bazaar extension" warning)', async () => {
    // The adapter validates route extensions lazily (a dynamic import of
    // @x402/extensions at the first request, console.warn on a bad one) and
    // the catalogue drops a route it would warn about, so the declaration is
    // checked here on a fresh app: charge() mounts on '*', so the one
    // wildcard notice core prints is expected and everything else is not.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = await listen(createVendorSimApp(paywall, { today: TODAY }));
    try {
      await getOffer(`${fresh.base}/v2/aggs/ticker/AAPL/range/1/day/2019-03-04/2019-03-05`);
      await getOffer(`${fresh.base}/v2/reference/news?ticker=AAPL`);
      // A second round after the import has settled, so a warning logged late is seen.
      await new Promise((r) => setTimeout(r, 50));
      await getOffer(`${fresh.base}/v2/aggs/ticker/AAPL/range/1/day/2019-03-04/2019-03-05`);
      await new Promise((r) => setTimeout(r, 50));
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines.filter((l) => /invalid bazaar extension|malformed/.test(l))).toEqual([]);
      expect(lines.filter((l) => !/Wildcard/.test(l))).toEqual([]);
    } finally {
      warn.mockRestore();
      await closeServer(fresh.server);
    }
  });

  it('402 on news carries its own template', async () => {
    const { required } = await getOffer(`${base}/v2/reference/news?ticker=AAPL&limit=5`);
    const extensions = (required as { extensions?: Record<string, any> }).extensions!;
    expect(extensions.bazaar.routeTemplate).toBe('/v2/reference/news');
    expect(extensions.bazaar.info.input).toMatchObject({ method: 'GET', queryParams: { ticker: 'AAPL', limit: '10' } });
    expect(JSON.stringify(extensions).length).toBeLessThan(4096);
  });

  it('a paid aggregates call: 200, settled, the Polygon body shape, weekdays only', async () => {
    // 2019-03-04 is a Monday; the range covers one week and the following weekend.
    const { res, body, key } = await buy(aggsUrl('AAPL', '2019-03-04', '2019-03-10'));
    expect(res.status).toBe(200);
    expect(readSettlement(res)).toMatchObject({ success: true, network: NETWORK, payer: accounts.payer.address });
    expect(facilitator.calls.map((c) => c.route)).toEqual(['verify', 'settle']);
    expect(facilitator.settled.has(key)).toBe(true);
    const b = body as AggsBody;
    expect(b).toMatchObject({ ticker: 'AAPL', status: 'OK', adjusted: true, queryCount: 5, resultsCount: 5, count: 5 });
    expect(b.request_id).toMatch(/^sim-[0-9a-f]{16}$/);
    expect(b.results).toHaveLength(5);
    expect(b.results.map((x) => new Date(x.t).getUTCDay())).toEqual([1, 2, 3, 4, 5]);
    expect(b.results.map((x) => x.t)).toEqual([4, 5, 6, 7, 8].map((d) => Date.UTC(2019, 2, d, 5)));
    for (const bar of b.results) {
      expect(Object.keys(bar).sort()).toEqual(['c', 'h', 'l', 'n', 'o', 't', 'v', 'vw']);
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
      expect(Math.max(bar.o, bar.c)).toBeLessThanOrEqual(bar.h);
      expect(bar.v).toBeGreaterThan(0);
    }
    // The same bars from a second app instance and a fresh path: nothing depends on process state.
    resetPaths();
    const other = await listen(createVendorSimApp(paywall));
    try {
      const again = await buy(`${other.base}/v2/aggs/ticker/AAPL/range/1/day/2019-03-04/2019-03-10`);
      expect(again.res.status).toBe(200);
      expect((again.body as AggsBody).results).toEqual(b.results);
      const msft = await buy(`${other.base}/v2/aggs/ticker/MSFT/range/1/day/2019-03-04/2019-03-10`);
      expect((msft.body as AggsBody).results.map((x) => x.c)).not.toEqual(b.results.map((x) => x.c));
    } finally {
      await closeServer(other.server);
    }
  });

  it('echoes adjusted=false, honours sort=desc and limit, and a weekend range is empty', async () => {
    const desc = await buy(aggsUrl('AAPL', '2019-03-04', '2019-03-10', '?adjusted=false&sort=desc&limit=2'));
    expect(desc.res.status).toBe(200);
    const b = desc.body as AggsBody;
    expect(b).toMatchObject({ adjusted: false, queryCount: 5, resultsCount: 2, count: 2 });
    expect(b.results[0]!.t).toBeGreaterThan(b.results[1]!.t);
    const weekend = await buy(aggsUrl('AAPL', '2019-03-09', '2019-03-10'));
    expect(weekend.res.status).toBe(200);
    expect(weekend.body).toMatchObject({ queryCount: 0, resultsCount: 0, count: 0, results: [] });
  });

  it('a bad request is refused after verify with 400 and Polygon error body; nothing is settled and the claim is released', async () => {
    const cases: Array<[string, RegExp]> = [
      [aggsUrl('AAPL', '2019-03-08', '2019-03-04'), /to must not be before from/],
      [aggsUrl('aapl', '2019-03-04', '2019-03-08'), /invalid ticker/],
      [aggsUrl('AAPL', '2019-02-30', '2019-03-08'), /invalid from date/],
      [aggsUrl('AAPL', '2019-03-04', 'tomorrow'), /invalid to date/],
      [aggsUrl('AAPL', '2014-01-01', '2019-03-08'), /five years/],
      [aggsUrl('AAPL', '2019-03-04', '2019-03-08', '?adjusted=maybe'), /adjusted/],
      [aggsUrl('AAPL', '2019-03-04', '2019-03-08', '?limit=0'), /limit/],
    ];
    for (const [url, message] of cases) {
      facilitator.calls.length = 0;
      const { res, body, key } = await buy(url);
      expect(res.status, url).toBe(400);
      expect(body, url).toMatchObject({ status: 'ERROR' });
      expect(body.error, url).toMatch(message);
      expect(res.headers.get('PAYMENT-RESPONSE'), url).toBeNull();
      expect(facilitator.calls.map((c) => c.route), url).toEqual(['verify']);
      expect(facilitator.settled.has(key), url).toBe(false);
      expect(paywall.store.has(key), url).toBe(false); // the authorization can be presented again
    }
  });

  it('only /range/1/day/ exists', async () => {
    const res = await fetch(`${base}/v2/aggs/ticker/AAPL/range/1/hour/2019-03-04/2019-03-08`);
    expect(res.status).toBe(404);
    expect(facilitator.calls).toHaveLength(0);
  });

  it('a paid news call: shape, limit cap and deterministic ids', async () => {
    const { res, body } = await buy(`${base}/v2/reference/news?ticker=AAPL&limit=3`);
    expect(res.status).toBe(200);
    expect(readSettlement(res)).toMatchObject({ success: true });
    expect(body).toMatchObject({ status: 'OK', count: 3 });
    expect(body.request_id).toMatch(/^sim-/);
    expect(body.results).toEqual(newsFor('AAPL', 3, TODAY));
    expect(body.results[0]).toMatchObject({ published_utc: '2026-09-01T13:00:00Z', tickers: ['AAPL'] });
    expect(body.results[0].article_url).toMatch(/^https:\/\/sim\.invalid\/news\/[0-9a-f]{16}$/);
    const ten = await buy(`${base}/v2/reference/news?ticker=AAPL`);
    expect(ten.body.count).toBe(10);
    const tooMany = await buy(`${base}/v2/reference/news?ticker=AAPL&limit=51`);
    expect(tooMany.res.status).toBe(400);
    const noTicker = await buy(`${base}/v2/reference/news`);
    expect(noTicker.res.status).toBe(400);
    expect(noTicker.body.error).toMatch(/ticker/);
  });
});
