/**
 * Deterministic market data for the vendor simulator. Nothing here is real:
 * the point is that `(ticker, day)` always yields the same bar, in every
 * process, so a buyer can verify a file it paid for by re-requesting it, and a
 * test can assert on exact values without a fixture.
 *
 * Each ticker is one log-price random walk from 2000-01-03 (a Monday). The
 * walk is memoised per ticker and extended lazily to the last day asked for,
 * so a bar's price depends on every bar before it (a path, not noise), while
 * the randomness of each step is seeded from FNV-1a("ticker|dayIndex") and so
 * needs no state to reproduce. Weekends are skipped; exchange holidays are not
 * modelled (a real vendor has none of 2000-01-17, 2000-02-21, ...).
 *
 * Bar timestamps follow Polygon: `t` is midnight America/New_York expressed as
 * a UTC epoch in milliseconds, which the simulator fixes at 05:00 UTC (EST)
 * regardless of daylight saving, since the reader only needs the calendar day.
 */

/** First bar of every path (a Monday). */
export const PATH_START = Date.UTC(2000, 0, 3);
/** Default "today" for the news feed; VENDOR_SIM_TODAY overrides it in main.ts. */
export const DEFAULT_TODAY = '2026-09-01T13:00:00Z';
const DAY_MS = 86_400_000;
/** Polygon's `t` for a day: its ET midnight; 05:00 UTC in winter, kept year-round for simplicity. */
const BAR_HOUR_UTC = 5;

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  n: number;
}

/** 32-bit FNV-1a of a string. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small, fast PRNG with a 32-bit seed; uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Calendar days between PATH_START and the UTC midnight of `ms` (negative before the start). */
const calendarDays = (ms: number): number => Math.floor((ms - PATH_START) / DAY_MS);

/**
 * Trading-day index of the first weekday on or after calendar day `d`
 * (d = 0 is 2000-01-03, a Monday, index 0). Saturday and Sunday map to the
 * following Monday.
 */
const tradingIndexAtOrAfter = (d: number): number => {
  const weeks = Math.floor(d / 7);
  const rem = d - weeks * 7; // 0 = Monday ... 6 = Sunday
  return weeks * 5 + Math.min(rem, 5);
};

/** UTC epoch ms of the `t` of trading day `index`. */
const timestampOf = (index: number): number => {
  const weeks = Math.floor(index / 5);
  const day = index - weeks * 5;
  return PATH_START + (weeks * 7 + day) * DAY_MS + BAR_HOUR_UTC * 3_600_000;
};

/** Ticker-level constants derived from its name: where the path starts and how wild it is. */
function profile(ticker: string): { startPrice: number; vol: number; drift: number; baseVolume: number } {
  const r = mulberry32(fnv1a(`${ticker}|profile`));
  return {
    startPrice: 5 + r() * 195, // $5 .. $200
    vol: 0.008 + r() * 0.02, // 0.8% .. 2.8% daily
    drift: 0.0001 + r() * 0.0004,
    baseVolume: Math.floor(200_000 + r() * 30_000_000),
  };
}

/** One standard normal from two uniforms (Box-Muller). */
const gaussian = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Per-ticker memoised paths: bars in trading-day order plus the unrounded close the next step continues from. */
const paths = new Map<string, { bars: Bar[]; logClose: number }>();

function pathFor(ticker: string, uptoIndex: number): Bar[] {
  let path = paths.get(ticker);
  if (!path) {
    path = { bars: [], logClose: Math.log(profile(ticker).startPrice) };
    paths.set(ticker, path);
  }
  const p = profile(ticker);
  for (let i = path.bars.length; i <= uptoIndex; i++) {
    const r = mulberry32(fnv1a(`${ticker}|${i}`));
    const open = path.logClose + p.vol * 0.3 * gaussian(r); // overnight gap
    const close = open + p.drift + p.vol * gaussian(r);
    const hi = Math.max(open, close) + Math.abs(p.vol * 0.6 * gaussian(r));
    const lo = Math.min(open, close) - Math.abs(p.vol * 0.6 * gaussian(r));
    const o = Math.exp(open);
    const c = Math.exp(close);
    const h = Math.exp(hi);
    const l = Math.exp(lo);
    // Volume-weighted price sits inside the day's range; volume scales with the move.
    const vw = l + (h - l) * (0.3 + 0.4 * r());
    const v = Math.max(1, Math.floor(p.baseVolume * (0.5 + r() + 20 * Math.abs(close - open))));
    // Rounding is monotonic, so l <= min(o,c) <= max(o,c) <= h survives it.
    path.bars.push({ t: timestampOf(i), o: round4(o), h: round4(h), l: round4(l), c: round4(c), v, vw: round4(vw), n: Math.max(1, Math.floor(v / (40 + 160 * r()))) });
    path.logClose = close;
  }
  return path.bars;
}

/** Parses a strict `YYYY-MM-DD` into UTC midnight ms, or undefined when it is not a real date. */
export function parseIsoDay(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Date.UTC normalises 2021-02-30 to March 2nd; a real vendor refuses it.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return undefined;
  return ms;
}

/**
 * Daily bars of `ticker` with `t` on or after `fromMs` and on or before
 * `toMs` (both UTC midnights of a calendar day; a bar's day is compared, not
 * its 05:00 offset). Ascending. Empty before PATH_START or when to < from.
 */
export function dailyBars(ticker: string, fromMs: number, toMs: number): Bar[] {
  if (toMs < fromMs) return [];
  const first = tradingIndexAtOrAfter(Math.max(0, calendarDays(fromMs)));
  const toDays = calendarDays(toMs);
  if (toDays < 0) return [];
  // tradingIndexAtOrAfter(to) is the day itself on a weekday and the next Monday on a weekend: exclude the latter.
  let last = tradingIndexAtOrAfter(toDays);
  if (timestampOf(last) - BAR_HOUR_UTC * 3_600_000 > toMs) last--;
  if (last < first) return [];
  return pathFor(ticker, last).slice(first, last + 1);
}

/** Drops every memoised path (tests only; the data is the same after). */
export function resetPaths(): void {
  paths.clear();
}

export interface NewsItem {
  id: string;
  publisher: { name: string; homepage_url: string };
  title: string;
  author: string;
  published_utc: string;
  article_url: string;
  tickers: string[];
  description: string;
  keywords: string[];
}

const TITLES = [
  '{T} shares rise as analysts revisit full-year outlook',
  '{T} slips after quarterly update misses expectations',
  'What the latest filing says about {T}',
  '{T} expands buyback programme',
  'Options activity in {T} picks up ahead of earnings',
  '{T} names new chief financial officer',
  'Why {T} is on watchlists this week',
  '{T} faces fresh questions over supply chain',
  'Institutional holders trim {T} positions',
  '{T} announces partnership in cloud services',
  'Analyst upgrades {T} on margin recovery',
  '{T} in focus as sector rotation continues',
];
const AUTHORS = ['Sim Newsdesk', 'A. Placeholder', 'Market Wire Bot'];
const KEYWORDS = ['earnings', 'guidance', 'analyst', 'buyback', 'options', 'management', 'supply chain', 'institutional', 'partnership', 'margins', 'rotation', 'filing'];

/**
 * The `limit` most recent items about `ticker`: one per day, item i published
 * i days before `today` at the same clock time. Titles cycle through twelve
 * templates seeded by the ticker, so the feed reads differently per ticker
 * but identically across processes. Every URL is under sim.invalid (RFC 2606):
 * nothing here resolves.
 */
export function newsFor(ticker: string, limit: number, today: Date): NewsItem[] {
  const items: NewsItem[] = [];
  for (let i = 0; i < limit; i++) {
    const r = mulberry32(fnv1a(`${ticker}|news|${i}`));
    const id = fnv1a(`${ticker}|news-id|${i}`).toString(16).padStart(8, '0') + fnv1a(`${i}|news-id|${ticker}`).toString(16).padStart(8, '0');
    const template = TITLES[Math.floor(r() * TITLES.length)]!;
    const title = template.replaceAll('{T}', ticker);
    const published = new Date(today.getTime() - i * DAY_MS);
    items.push({
      id,
      publisher: { name: 'Sim Newswire', homepage_url: 'https://sim.invalid/' },
      title,
      author: AUTHORS[Math.floor(r() * AUTHORS.length)]!,
      published_utc: published.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      article_url: `https://sim.invalid/news/${id}`,
      tickers: [ticker],
      description: `${title}. Simulated coverage for testing; no such event happened.`,
      keywords: [KEYWORDS[TITLES.indexOf(template)]!, ticker.toLowerCase()],
    });
  }
  return items;
}

/** A per-response id in the vendor's style, prefixed so a reader can tell it came from the simulator. */
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `sim-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
