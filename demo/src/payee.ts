/**
 * The demo merchant: an express app with two paid routes behind the x402
 * paywall (fixed per-call price, stateless) — the handlers never learn what
 * a payment is. `/flaky` fails on demand so a scenario can show that a
 * failed handler is never charged.
 */
import express from 'express';
import type { Server } from 'node:http';
import { createPaywall } from '@agentpay/payee';
import type { Address, AssetDomain, SettleResponse } from '@agentpay/core';

export interface PayeeOptions {
  port: number;
  network: string;
  asset: Address;
  assetDomain: AssetDomain;
  payTo: Address;
  facilitatorUrl: string;
  maxTimeoutSeconds?: number;
  onSettled?: (result: SettleResponse) => void;
}

export interface PayeeHandle {
  url: string;
  served: { predict: number; analyze: number; flaky: number };
  /** When true, /flaky answers 500 after the paywall verified the payment. */
  flaky: { fail: boolean };
  close(): Promise<void>;
}

export async function startPayee(opts: PayeeOptions): Promise<PayeeHandle> {
  const served = { predict: 0, analyze: 0, flaky: 0 };
  const flaky = { fail: false };
  const paywall = createPaywall({
    facilitator: { url: opts.facilitatorUrl },
    network: opts.network,
    asset: opts.asset,
    assetDomain: opts.assetDomain,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
    onSettled: (result) => opts.onSettled?.(result),
    log: () => {},
  });
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true, served });
  });

  app.get('/predict', paywall.charge('$0.001', { description: 'ETH-USD prediction', mimeType: 'application/json' }), (_req, res) => {
    served.predict++;
    res.json({ symbol: 'ETH-USD', price: 4005.32 + served.predict / 100, timestamp: Date.now() });
  });

  app.post('/analyze', express.json(), paywall.charge('$0.01', { description: 'text analysis' }), (req, res) => {
    served.analyze++;
    const text = String((req.body as { text?: unknown })?.text ?? '');
    res.json({ words: text.split(/\s+/).filter(Boolean).length, sentiment: text.includes('!') ? 'excited' : 'neutral' });
  });

  app.get('/flaky', paywall.charge('$0.001'), (_req, res) => {
    served.flaky++;
    if (flaky.fail) res.status(500).json({ error: 'upstream exploded' });
    else res.json({ ok: true });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    flaky,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
