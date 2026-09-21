/**
 * In-process stand-in for the CDP Bazaar: node:http on an ephemeral port
 * serving `/discovery/search` and `/discovery/resources` from the fixtures
 * (rows in the catalogue's real shape, captured 2026-09-21), recording every
 * query string it receives. `mode` steers how it fails: a 500, a body that
 * is not JSON, or an answer that never comes within the client's timeout.
 * Like CDP, `/discovery/resources` honours `offset` and ignores `limit` and
 * `network` (the whole fixture comes back), so the client must filter.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type StubBazaarMode = 'ok' | 'http-500' | 'garbage' | 'slow';

export interface RecordedCall {
  path: string;
  params: Record<string, string>;
}

export interface StubBazaar {
  url: string;
  mode: StubBazaarMode;
  /** Every request, in order, with its query parameters. */
  calls: RecordedCall[];
  /** How long `slow` holds a response (default 30 s: longer than any test timeout, so the client's own timeout is what ends it). */
  slowMs: number;
  close(): Promise<void>;
}

const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

export const SEARCH_FIXTURE = fixture('bazaar-search.json') as { resources: Array<Record<string, unknown>>; partialResults: boolean };
export const RESOURCES_FIXTURE = fixture('bazaar-resources.json') as { items: Array<Record<string, unknown>> };

export async function startStubBazaar(mode: StubBazaarMode = 'ok'): Promise<StubBazaar> {
  const state: StubBazaar = { url: '', mode, calls: [], slowMs: 30_000, close: async () => undefined };
  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub');
    state.calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams.entries()) });
    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (state.mode === 'http-500') return json(500, { error: 'internal' });
    if (state.mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('<html>not json</html>');
    }
    if (state.mode === 'slow') {
      // Hold the socket: the client's AbortSignal must fire, not the server's goodwill.
      const t = setTimeout(() => json(200, SEARCH_FIXTURE), state.slowMs);
      timers.add(t);
      res.on('close', () => {
        clearTimeout(t);
        timers.delete(t);
      });
      return;
    }
    if (u.pathname === '/discovery/search') return json(200, SEARCH_FIXTURE);
    if (u.pathname === '/discovery/resources') {
      const offset = Number(u.searchParams.get('offset') ?? '0');
      const items = RESOURCES_FIXTURE.items.slice(offset);
      return json(200, { items, pagination: { limit: 20, offset, total: RESOURCES_FIXTURE.items.length }, x402Version: 2 });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
