/**
 * Example paid API behind the AEP2 mandate paywall.
 *
 *   npm start -w @agentpay/payee        (or `npm run payee` from the repo root)
 *
 * Environment (see .env.example):
 *   PAYEE_PK         payee signing key; only its address (payTo) is used. Defaults to hardhat #2 on eip155:31337.
 *   PAYEE_PORT       default 4021
 *   RPC_URL          enables on-chain pre-checks on eip155:31337 (default http://127.0.0.1:8545 there)
 *   SP_URL           default http://127.0.0.1:3001
 *   SP_ADDRESS       default: read from `${SP_URL}/supported`
 *   SETTLE_WINDOW    default: the SP's advertised settleWindowSeconds, else 10800
 *   NETWORK, WALLET_ADDRESS, USDC_ADDRESS
 *                    default: packages/contracts/deployments/${DEPLOYMENT ?? 'localhost'}.json
 */
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { readDeployment } from '@agentpay/contracts';
import { formatUsdc, type Address, type Hex } from '@agentpay/core';
import { createMandatePaywall, type MandatePaywallOptions } from '../src/index.js';

// Hardhat public dev key #2 ("payee") — local development only, never real funds.
const HARDHAT_PAYEE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;

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
const spUrl = (env.SP_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');

// ---- chain / contracts: env first, then the deployment record ----
let network = env.NETWORK;
let walletAddress = env.WALLET_ADDRESS;
let usdcAddress = env.USDC_ADDRESS;
if (!network || !walletAddress || !usdcAddress) {
  const name = env.DEPLOYMENT ?? 'localhost';
  try {
    const d = readDeployment(name);
    network ??= d.network;
    walletAddress ??= d.wallet;
    usdcAddress ??= d.usdc;
  } catch (err) {
    fail(`NETWORK / WALLET_ADDRESS / USDC_ADDRESS unset and deployment '${name}' unreadable: ${(err as Error).message}`);
  }
}
const wallet = asAddress(walletAddress, 'WALLET_ADDRESS');
const asset = asAddress(usdcAddress, 'USDC_ADDRESS');
const isLocal = network === 'eip155:31337';
const rpcUrl = env.RPC_URL ?? (isLocal ? 'http://127.0.0.1:8545' : undefined);

// ---- settlement processor: env first, then its /supported endpoint ----
let spAddress = env.SP_ADDRESS;
let settleWindow = env.SETTLE_WINDOW ? Number(env.SETTLE_WINDOW) : undefined;
if (!spAddress || settleWindow === undefined) {
  try {
    const res = await fetch(`${spUrl}/supported`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as { sp?: string; settleWindowSeconds?: number; wallet?: string; network?: string };
    spAddress ??= s.sp;
    settleWindow ??= s.settleWindowSeconds;
    if (s.wallet && s.wallet.toLowerCase() !== wallet.toLowerCase()) {
      console.warn(`payee: SP settles against wallet ${s.wallet}, but this payee is configured for ${wallet}`);
    }
    if (s.network && s.network !== network) {
      console.warn(`payee: SP serves ${s.network}, but this payee is configured for ${network}`);
    }
  } catch (err) {
    if (!spAddress) fail(`SP_ADDRESS unset and ${spUrl}/supported unreachable: ${(err as Error).message}`);
  }
}
const sp = {
  url: spUrl,
  address: asAddress(spAddress, 'SP_ADDRESS'),
  settleWindowSeconds: settleWindow ?? 10_800,
};

// ---- payee identity ----
const payeeKey = env.PAYEE_PK ?? (isLocal ? HARDHAT_PAYEE_KEY : undefined);
if (!payeeKey) fail('PAYEE_PK is required outside the local hardhat network');
const payTo = privateKeyToAccount(payeeKey as Hex).address;

const common: Omit<MandatePaywallOptions, 'price'> = {
  network: network!,
  asset,
  payTo,
  wallet,
  sp,
  rpcUrl,
  onEnqueued: (info, req) => {
    console.log(
      `[payee] enqueued ${req.method} ${req.path} payer=${info.payer} digest=${info.mandateDigest} ` +
        `settleBy=${new Date(info.spReceipt.enqueueDeadline * 1000).toISOString()}`,
    );
  },
};

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, network, payTo, wallet, asset, sp: sp.url, spAddress: sp.address, settleWindowSeconds: sp.settleWindowSeconds });
});

app.get('/predict', createMandatePaywall({ ...common, price: '$0.001' }), (_req, res) => {
  const timestamp = Math.floor(Date.now() / 1000);
  // A "prediction": a deterministic wobble around a base price.
  const price = Number((3000 + 40 * Math.sin(timestamp / 60)).toFixed(2));
  res.json({ symbol: 'ETH-USD', price, timestamp });
});

app.post('/analyze', createMandatePaywall({ ...common, price: '$0.01', includeBodyPaymentField: true }), (req, res) => {
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
  console.log(`[payee] wallet=${wallet} asset=${asset} sp=${sp.url} (${sp.address}) settleWindow=${sp.settleWindowSeconds}s`);
  console.log(`[payee] verifyOnChain=${isLocal && !!rpcUrl}${rpcUrl ? ` rpc=${rpcUrl}` : ''}`);
  console.log(`[payee] GET /health (free) | GET /predict (${formatUsdc(1_000n)}) | POST /analyze (${formatUsdc(10_000n)}, body {text})`);
});
