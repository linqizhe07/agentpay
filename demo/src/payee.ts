/**
 * The demo merchant: an express app with two paid routes behind the AEP2
 * mandate paywall. Mirrors FluxA's "Monetize gateway" mode (fixed per-call
 * price, stateless) — the handlers never learn what a mandate is.
 */
import express from 'express';
import type { Server } from 'node:http';
import { createMandatePaywall } from '@agentpay/payee';
import type { Address, SettlementInfo } from '@agentpay/core';

export interface PayeeOptions {
  port: number;
  rpcUrl: string;
  network: string;
  asset: Address;
  payTo: Address;
  wallet: Address;
  sp: { url: string; address: Address; settleWindowSeconds: number };
  onEnqueued?: (info: SettlementInfo, resource: string) => void;
}

export interface PayeeHandle {
  url: string;
  served: { predict: number; analyze: number };
  close(): Promise<void>;
}

export async function startPayee(opts: PayeeOptions): Promise<PayeeHandle> {
  const served = { predict: 0, analyze: 0 };
  const app = express();
  const common = {
    network: opts.network,
    asset: opts.asset,
    payTo: opts.payTo,
    wallet: opts.wallet,
    sp: opts.sp,
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, served });
  });

  // $0.001 per quote; local chain -> the paywall pre-checks balance + nonce on-chain.
  app.get(
    '/predict',
    createMandatePaywall({
      ...common,
      price: '$0.001',
      verifyOnChain: true,
      rpcUrl: opts.rpcUrl,
      onEnqueued: (info) => opts.onEnqueued?.(info, 'GET /predict'),
    }),
    (_req, res) => {
      served.predict++;
      res.json({ symbol: 'ETH-USD', price: 4005.32 + served.predict / 100, timestamp: Date.now() });
    },
  );

  // $0.01 per analysis; no on-chain pre-check (the SP is the gate), FluxA-style
  // in-body `payment` field so callers can see the receipt without headers.
  app.post(
    '/analyze',
    express.json(),
    createMandatePaywall({
      ...common,
      price: '$0.01',
      verifyOnChain: false,
      includeBodyPaymentField: true,
      onEnqueued: (info) => opts.onEnqueued?.(info, 'POST /analyze'),
    }),
    (req, res) => {
      served.analyze++;
      const text = String((req.body as { text?: unknown })?.text ?? '');
      res.json({ words: text.split(/\s+/).filter(Boolean).length, sentiment: text.includes('!') ? 'excited' : 'neutral' });
    },
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
