/**
 * Example paid API behind the x402 paywall.
 *
 *   npm start -w @agentpay/payee        (or `npm run payee` from the repo root)
 *
 * Environment (see .env.example and ./env.ts for the shared variables):
 *   PAYEE_PORT        default 4021
 *   PAYEE_ADDRESS, FACILITATOR_URL, FACILITATOR_AUTH_TOKEN, PAYEE_RPC_URL,
 *   NETWORK, USDC_ADDRESS, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION   see env.ts
 */
import express from 'express';
import { formatUsdc } from '@agentpay/core';
import { createPaywall } from '../src/index.js';
import { resolvePayeeEnv, warnIfFacilitatorUnsupported } from './env.js';

const env = process.env;
const port = Number(env.PAYEE_PORT ?? 4021);
const { network, asset, assetDomain, payTo, facilitatorUrl, facilitatorAuthToken, rpcUrl } = resolvePayeeEnv(env);
await warnIfFacilitatorUnsupported(facilitatorUrl, network);

const paywall = createPaywall({
  facilitator: { url: facilitatorUrl, authToken: facilitatorAuthToken },
  network,
  asset,
  assetDomain,
  payTo,
  rpcUrl,
  onSettled: (result, ctx) => {
    const req = (ctx.transportContext as { request?: { method?: string; path?: string } } | undefined)?.request;
    console.log(`[payee] settled ${req?.method ?? '?'} ${req?.path ?? '?'} payer=${result.payer} tx=${result.transaction}`);
  },
});

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, network, payTo, asset, assetDomain, facilitator: facilitatorUrl });
});

app.get('/predict', paywall.charge('$0.001', { description: 'ETH-USD prediction', mimeType: 'application/json' }), (_req, res) => {
  const timestamp = Math.floor(Date.now() / 1000);
  // A "prediction": a deterministic wobble around a base price.
  const price = Number((3000 + 40 * Math.sin(timestamp / 60)).toFixed(2));
  res.json({ symbol: 'ETH-USD', price, timestamp });
});

app.post('/analyze', paywall.charge('$0.01', { description: 'text analysis', mimeType: 'application/json' }), (req, res) => {
  const text = String((req.body as { text?: unknown } | undefined)?.text ?? '');
  const words = text.split(/\s+/).filter(Boolean);
  const sentiment = /\b(bad|terrible|awful|down|loss)\b/i.test(text)
    ? 'negative'
    : /\b(good|great|excellent|up|gain)\b/i.test(text)
      ? 'positive'
      : 'neutral';
  res.json({
    text,
    chars: text.length,
    words: words.length,
    sentiment,
    keywords: [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 5),
  });
});

app.listen(port, () => {
  console.log(`[payee] listening on http://127.0.0.1:${port}  network=${network} payTo=${payTo}`);
  console.log(`[payee] asset=${asset} (${assetDomain.name} v${assetDomain.version}) facilitator=${facilitatorUrl} rpc=${rpcUrl ?? '(none)'}`);
  console.log(`[payee] GET /health (free) | GET /predict (${formatUsdc(1_000n)}) | POST /analyze (${formatUsdc(10_000n)}, body {text})`);
});
