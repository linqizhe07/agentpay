/**
 * vendor-sim: a paid market-data vendor in Massive's shape, for buying data
 * with the wallet on a local chain or Base Sepolia before the real vendor
 * (which only sells on Base mainnet) is in reach.
 *
 *   npm run vendor-sim                (root or -w @agentpay/payee)
 *
 * Environment (see .env.example and ../env.ts for the shared payee variables):
 *   VENDOR_SIM_PORT    default 4022
 *   VENDOR_SIM_TODAY   ISO instant the news feed counts back from; default 2026-09-01T13:00:00Z
 *   PAYEE_ADDRESS, FACILITATOR_URL, FACILITATOR_AUTH_TOKEN, PAYEE_RPC_URL,
 *   NETWORK, USDC_ADDRESS, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION            see env.ts
 *
 * How the real Massive (agent.massive.com) differs, so nobody mistakes a green
 * run here for a green run there:
 *   - it accepts USDC on Base MAINNET only (eip155:8453); this simulator sells
 *     on whatever NETWORK the paywall is configured for;
 *   - it rate-limits and answers 429 (with Retry-After) under load, and the
 *     paid quota is per key; the simulator never refuses a well-formed call;
 *   - long ranges come back paginated (`next_url`, 50 000 bars a page); the
 *     simulator caps a range at five years and never paginates;
 *   - its calendar has exchange holidays and half days; the simulator only
 *     skips weekends, so it has ~9 more bars a year;
 *   - its prices are real and `adjusted=true` applies splits and dividends;
 *     the simulator's prices are a seeded random walk and `adjusted` is only
 *     echoed (there are no corporate actions to apply);
 *   - its news is real and paginated with `published_utc.gte` filters; the
 *     simulator serves templated headlines under sim.invalid.
 * Prices ($0.01 a call) and the response shapes are the same.
 */
import { formatUsdc } from '@agentpay/core';
import { createPaywall } from '../../src/index.js';
import { resolvePayeeEnv, warnIfFacilitatorUnsupported } from '../env.js';
import { createVendorSimApp, AGGS_TEMPLATE, NEWS_TEMPLATE } from './app.js';
import { DEFAULT_TODAY } from './data.js';

const TAG = 'vendor-sim';
const env = process.env;
const port = Number(env.VENDOR_SIM_PORT ?? 4022);
const today = new Date(env.VENDOR_SIM_TODAY ?? DEFAULT_TODAY);
if (Number.isNaN(today.getTime())) {
  console.error(`${TAG}: VENDOR_SIM_TODAY is not an ISO instant: ${env.VENDOR_SIM_TODAY}`);
  process.exit(2);
}
const { network, asset, assetDomain, payTo, facilitatorUrl, facilitatorAuthToken, rpcUrl } = resolvePayeeEnv(env, TAG);
await warnIfFacilitatorUnsupported(facilitatorUrl, network, TAG);

const paywall = createPaywall({
  facilitator: { url: facilitatorUrl, authToken: facilitatorAuthToken },
  network,
  asset,
  assetDomain,
  payTo,
  rpcUrl,
  onSettled: (result, ctx) => {
    const req = (ctx.transportContext as { request?: { method?: string; path?: string } } | undefined)?.request;
    console.log(`[${TAG}] settled ${req?.method ?? '?'} ${req?.path ?? '?'} payer=${result.payer} tx=${result.transaction}`);
  },
});

const app = createVendorSimApp(paywall, { today });
app.listen(port, () => {
  console.log(`[${TAG}] listening on http://127.0.0.1:${port}  network=${network} payTo=${payTo}`);
  console.log(`[${TAG}] asset=${asset} (${assetDomain.name} v${assetDomain.version}) facilitator=${facilitatorUrl} rpc=${rpcUrl ?? '(none)'} today=${today.toISOString()}`);
  console.log(`[${TAG}] GET /health (free) | GET ${AGGS_TEMPLATE} (${formatUsdc(10_000n)}) | GET ${NEWS_TEMPLATE}?ticker&limit (${formatUsdc(10_000n)})`);
});
