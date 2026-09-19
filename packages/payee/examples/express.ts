/**
 * Example paid API behind the x402 paywall.
 *
 *   npm start -w @agentpay/payee        (or `npm run payee` from the repo root)
 *
 * Environment (see .env.example):
 *   PAYEE_ADDRESS     where settlements go. Defaults to hardhat #2 on eip155:31337.
 *   PAYEE_PORT        default 4021
 *   FACILITATOR_URL   default http://127.0.0.1:3001, or the deployment record's facilitatorUrl
 *                     (https://x402.org/facilitator for base-sepolia)
 *   FACILITATOR_AUTH_TOKEN  optional bearer token for a self-hosted facilitator
 *   NETWORK, USDC_ADDRESS, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION
 *                     default: packages/contracts/deployments/${DEPLOYMENT ?? 'localhost'}.json
 */
import express from 'express';
import { readDeployment } from '@agentpay/contracts';
import { formatUsdc, type Address, type AssetDomain } from '@agentpay/core';
import { createPaywall } from '../src/index.js';

// Hardhat public dev account #2 ("payee") — local development only.
const HARDHAT_PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

function fail(message: string): never {
  console.error(`payee: ${message}`);
  process.exit(2);
}

function asAddress(value: string | undefined, name: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${name} is not an address: ${value ?? '(unset)'}`);
  return value as Address;
}

const env = process.env;
const port = Number(env.PAYEE_PORT ?? 4021);

// ---- chain / token: env first, then the deployment record ----
let network = env.NETWORK;
let usdcAddress = env.USDC_ADDRESS;
let assetDomain: AssetDomain | undefined =
  env.USDC_DOMAIN_NAME && env.USDC_DOMAIN_VERSION ? { name: env.USDC_DOMAIN_NAME, version: env.USDC_DOMAIN_VERSION } : undefined;
let facilitatorUrl = env.FACILITATOR_URL;
if (!network || !usdcAddress || !assetDomain || !facilitatorUrl) {
  const name = env.DEPLOYMENT ?? 'localhost';
  try {
    const d = readDeployment(name);
    network ??= d.network;
    usdcAddress ??= d.usdc;
    assetDomain ??= d.usdcDomain;
    facilitatorUrl ??= d.facilitatorUrl ?? 'http://127.0.0.1:3001';
  } catch (err) {
    fail(`NETWORK / USDC_ADDRESS / USDC_DOMAIN_* unset and deployment '${name}' unreadable: ${(err as Error).message}`);
  }
}
const asset = asAddress(usdcAddress, 'USDC_ADDRESS');
const isLocal = network === 'eip155:31337';
const payTo = asAddress(env.PAYEE_ADDRESS ?? (isLocal ? HARDHAT_PAYEE : undefined), 'PAYEE_ADDRESS');

// ---- facilitator: warn early when it does not serve this network ----
try {
  const res = await fetch(`${facilitatorUrl}/supported`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const s = (await res.json()) as { kinds?: Array<{ x402Version: number; scheme: string; network: string }> };
  const ok = s.kinds?.some((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network);
  if (!ok) console.warn(`payee: ${facilitatorUrl} does not list { x402Version: 2, scheme: 'exact', network: '${network}' }`);
} catch (err) {
  console.warn(`payee: ${facilitatorUrl}/supported unreachable (${(err as Error).message}); paid calls will fail until it is up`);
}

const paywall = createPaywall({
  facilitator: { url: facilitatorUrl!, authToken: env.FACILITATOR_AUTH_TOKEN },
  network: network!,
  asset,
  assetDomain: assetDomain!,
  payTo,
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
  console.log(`[payee] asset=${asset} (${assetDomain!.name} v${assetDomain!.version}) facilitator=${facilitatorUrl}`);
  console.log(`[payee] GET /health (free) | GET /predict (${formatUsdc(1_000n)}) | POST /analyze (${formatUsdc(10_000n)}, body {text})`);
});
