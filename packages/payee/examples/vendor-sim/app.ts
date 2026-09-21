/**
 * A paid market-data vendor in the shape of Massive (agent.massive.com,
 * Polygon.io lineage): the same paths, query parameters and response bodies,
 * behind our paywall at $0.01 per call, serving the deterministic data of
 * data.ts. A buyer written against this simulator should only need to change
 * the base URL (and the network) to buy from the real vendor.
 *
 * Validation happens in the handler, after the paywall: the paywall verifies
 * the payment first, the handler answers 400, and @x402/express then cancels
 * the settlement (the handler's non-2xx status), so a bad request costs the
 * buyer nothing but a signature. That matches what a real vendor does.
 */
import express, { type Express } from 'express';
import type { Paywall } from '../../src/index.js';
import { DEFAULT_TODAY, dailyBars, newsFor, parseIsoDay, requestId } from './data.js';

export interface VendorSimOptions {
  /** "Now" for the news feed (item i is published i days before it). Default DEFAULT_TODAY. */
  today?: Date;
}

export const AGGS_TEMPLATE = '/v2/aggs/ticker/:ticker/range/1/day/:from/:to';
export const NEWS_TEMPLATE = '/v2/reference/news';
export const PRICE = '$0.01';
const TICKER_RE = /^[A-Z.\-]{1,10}$/;
const MAX_SPAN_DAYS = 5 * 366;
const MAX_NEWS = 50;
const DAY_MS = 86_400_000;

/** Polygon's error body. */
const error = (message: string) => ({ status: 'ERROR', error: message, request_id: requestId() });

export function createVendorSimApp(paywall: Paywall, opts: VendorSimOptions = {}): Express {
  const today = opts.today ?? new Date(DEFAULT_TODAY);
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      vendor: 'vendor-sim',
      today: today.toISOString(),
      routes: [
        { method: 'GET', path: '/health', price: null },
        { method: 'GET', path: AGGS_TEMPLATE, price: PRICE, query: ['adjusted', 'sort', 'limit'] },
        { method: 'GET', path: NEWS_TEMPLATE, price: PRICE, query: ['ticker', 'limit'] },
      ],
    });
  });

  // Aggregates. Examples are what the catalogue shows a buyer's agent: two
  // bars is enough to show the shape and keeps the 402 well under 4 KB.
  app.get(
    AGGS_TEMPLATE,
    paywall.charge(PRICE, {
      description: 'Daily OHLCV aggregates for a US equity ticker over a date range (simulated, deterministic; Polygon/Massive shape)',
      mimeType: 'application/json',
      discovery: {
        routeTemplate: AGGS_TEMPLATE,
        pathParams: { ticker: 'AAPL', from: '2019-03-04', to: '2019-03-05' },
        pathParamsSchema: {
          properties: {
            ticker: { type: 'string', description: 'Ticker symbol, upper case' },
            from: { type: 'string', description: 'Start day, YYYY-MM-DD' },
            to: { type: 'string', description: 'End day, YYYY-MM-DD (inclusive, at most five years after from)' },
          },
          required: ['ticker', 'from', 'to'],
        },
        input: { adjusted: 'true', sort: 'asc', limit: '50000' },
        inputSchema: {
          properties: {
            adjusted: { type: 'string', enum: ['true', 'false'], description: 'Echoed in the body; the simulator has no corporate actions' },
            sort: { type: 'string', enum: ['asc', 'desc'] },
            limit: { type: 'string', description: 'Maximum bars, 1..50000' },
          },
        },
        output: {
          example: {
            ticker: 'AAPL',
            queryCount: 2,
            resultsCount: 2,
            adjusted: true,
            results: [
              // The simulator's own bars for AAPL 2019-03-04 and 2019-03-05 (they never change).
              { t: 1551675600000, o: 149.9421, h: 151.2009, l: 144.7723, c: 146.6648, v: 23325578, vw: 148.6408, n: 177454 },
              { t: 1551762000000, o: 146.473, h: 156.353, l: 145.7975, c: 153.6158, v: 29873848, vw: 151.5721, n: 193759 },
            ],
            status: 'OK',
            request_id: 'sim-0123456789abcdef',
            count: 2,
          },
        },
      },
    }),
    (req, res) => {
      const { ticker, from, to } = req.params as Record<string, string>;
      if (!TICKER_RE.test(ticker!)) return res.status(400).json(error(`invalid ticker: ${ticker}`));
      const fromMs = parseIsoDay(from!);
      const toMs = parseIsoDay(to!);
      if (fromMs === undefined) return res.status(400).json(error(`invalid from date: ${from}`));
      if (toMs === undefined) return res.status(400).json(error(`invalid to date: ${to}`));
      if (toMs < fromMs) return res.status(400).json(error('to must not be before from'));
      if (toMs - fromMs > MAX_SPAN_DAYS * DAY_MS) return res.status(400).json(error('range must not exceed five years'));
      const q = req.query as Record<string, string | undefined>;
      const adjusted = q.adjusted === undefined ? true : q.adjusted === 'true' ? true : q.adjusted === 'false' ? false : undefined;
      if (adjusted === undefined) return res.status(400).json(error(`adjusted must be true or false: ${q.adjusted}`));
      const sort = q.sort ?? 'asc';
      if (sort !== 'asc' && sort !== 'desc') return res.status(400).json(error(`sort must be asc or desc: ${q.sort}`));
      const limit = q.limit === undefined ? 5000 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) return res.status(400).json(error(`limit must be an integer 1..50000: ${q.limit}`));

      const all = dailyBars(ticker!, fromMs, toMs);
      const ordered = sort === 'desc' ? [...all].reverse() : all;
      const results = ordered.slice(0, limit);
      // `adjusted` is echoed so a reader can refuse split-adjusted data (the
      // simulator has no corporate actions; the flag changes nothing here).
      return res.json({ ticker, queryCount: all.length, resultsCount: results.length, adjusted, results, status: 'OK', request_id: requestId(), count: results.length });
    },
  );

  app.get(
    NEWS_TEMPLATE,
    paywall.charge(PRICE, {
      description: 'Recent news articles for a US equity ticker (simulated; Polygon/Massive shape)',
      mimeType: 'application/json',
      discovery: {
        routeTemplate: NEWS_TEMPLATE,
        input: { ticker: 'AAPL', limit: '10' },
        inputSchema: {
          properties: {
            ticker: { type: 'string', description: 'Ticker symbol, upper case' },
            limit: { type: 'string', description: 'Articles to return, 1..50 (default 10)' },
          },
          required: ['ticker'],
        },
        output: {
          example: {
            results: [
              {
                id: '5f3c2a1b9e8d7c6f',
                publisher: { name: 'Sim Newswire', homepage_url: 'https://sim.invalid/' },
                title: 'AAPL shares rise as analysts revisit full-year outlook',
                author: 'Sim Newsdesk',
                published_utc: '2026-09-01T13:00:00Z',
                article_url: 'https://sim.invalid/news/5f3c2a1b9e8d7c6f',
                tickers: ['AAPL'],
                description: 'Simulated coverage for testing; no such event happened.',
                keywords: ['earnings', 'aapl'],
              },
            ],
            status: 'OK',
            request_id: 'sim-0123456789abcdef',
            count: 1,
          },
        },
      },
    }),
    (req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const ticker = q.ticker;
      if (ticker === undefined || !TICKER_RE.test(ticker)) return res.status(400).json(error(`invalid ticker: ${ticker ?? '(missing)'}`));
      const limit = q.limit === undefined ? 10 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEWS) return res.status(400).json(error(`limit must be an integer 1..${MAX_NEWS}: ${q.limit}`));
      const results = newsFor(ticker, limit, today);
      return res.json({ results, status: 'OK', request_id: requestId(), count: results.length });
    },
  );

  return app;
}
