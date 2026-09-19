/**
 * End-to-end demo: a fresh local chain, a facilitator, a paid API, and an
 * agent wallet with a user-approved budget, all speaking x402 (`exact`,
 * EIP-3009) — every paid call is settled on chain before it is answered.
 *
 *   npm run demo                # all scenarios
 *   npm run demo -- --only concurrency
 *
 * Exit code 0 iff every scenario's assertions pass.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { MOCK_USDC_ABI, MOCK_USDC_DOMAIN, deployLocalFixture } from '@agentpay/contracts';
import { EIP3009_ABI, PolicyViolation, formatUsdc } from '@agentpay/core';
import { Ledger, MandateWallet } from '@agentpay/wallet';
import { DEV } from './accounts.js';
import { startChain, type ChainHandle } from './chain.js';
import { startFacilitator } from './facilitator.js';
import { startPayee, type PayeeHandle } from './payee.js';
import { parseOnly, short } from './util.js';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const CHAIN_PORT = 8545;
const FACILITATOR_PORT = 3001;
const PAYEE_PORT = 4021;
const NETWORK = 'eip155:31337';
/** How long a signed authorization stays valid (the payee's maxTimeoutSeconds). */
const AUTH_VALIDITY = 60;

// ------------------------------------------------------------ narration

const failures: string[] = [];
let currentScenario = '';

function log(line = ''): void {
  console.log(line ? `  ${line}` : '');
}

function heading(title: string): void {
  console.log(`\n==== ${title} ${'='.repeat(Math.max(4, 70 - title.length))}`);
}

function check(condition: unknown, what: string): void {
  if (condition) {
    log(`✓ ${what}`);
  } else {
    failures.push(`${currentScenario}: ${what}`);
    log(`✗ ${what}`);
  }
}

// ------------------------------------------------------------ environment

interface Env {
  chain: ChainHandle;
  rpcUrl: string;
  usdc: `0x${string}`;
  facilitator: Awaited<ReturnType<typeof startFacilitator>>;
  payee: PayeeHandle;
  agent: MandateWallet;
  budgetId: string;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  settlements: Hex[];
  latenciesMs: number[];
}

async function setup(): Promise<Env> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  heading('Setup');
  const chain = await startChain({ port: CHAIN_PORT });
  log(`hardhat node on ${chain.rpcUrl}`);
  const transport = http(chain.rpcUrl, { retryCount: 0 });
  const publicClient = createPublicClient({ chain: hardhat, transport, pollingInterval: 50 });
  const testClient = createTestClient({ chain: hardhat, mode: 'hardhat', transport, pollingInterval: 50 });
  const deployer = createWalletClient({ account: privateKeyToAccount(DEV.deployer.key), chain: hardhat, transport, pollingInterval: 50 });

  const { usdc } = await deployLocalFixture(deployer, publicClient, testClient);
  log(`MockUSDC ${short(usdc)} (EIP-3009, domain "${MOCK_USDC_DOMAIN.name}" v${MOCK_USDC_DOMAIN.version}) + Multicall3 · no contract of ours`);
  const hash = await deployer.writeContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'mint', args: [DEV.payer.address, parseUnits('10000', 6)] });
  await publicClient.waitForTransactionReceipt({ hash });

  const facilitator = await startFacilitator({
    rpcUrl: chain.rpcUrl,
    chainId: hardhat.id,
    key: DEV.facilitator.key,
    usdc,
    usdcDomain: { ...MOCK_USDC_DOMAIN },
    port: FACILITATOR_PORT,
  });
  log(`facilitator ${short(DEV.facilitator.address)} on ${facilitator.url} (pays gas; settles exact/eip155:31337)`);

  const settlements: Hex[] = [];
  const payee = await startPayee({
    port: PAYEE_PORT,
    network: NETWORK,
    asset: usdc,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    payTo: DEV.payee.address,
    facilitatorUrl: facilitator.url,
    maxTimeoutSeconds: AUTH_VALIDITY,
    onSettled: (r) => settlements.push(r.transaction as Hex),
  });
  log(`payee ${short(DEV.payee.address)} on ${payee.url}: GET /predict $0.001 · POST /analyze $0.01 · GET /flaky $0.001`);

  const agent = new MandateWallet({
    key: DEV.payer.key,
    rpcUrl: chain.rpcUrl,
    token: usdc,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: NETWORK,
    mandatesPath: resolve(OUT_DIR, 'mandates.json'),
    ledgerPath: resolve(OUT_DIR, 'ledger.jsonl'),
  });
  log(`agent ${short(agent.address)} holds ${formatUsdc(await agent.balance())} USDC in its own account (no ETH, no deposit, no approval)`);

  const budget = await agent.createIntentMandate(
    { naturalLanguage: 'Market data and text analysis for the demo', limitAmount: '$5', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] },
    { approve: true },
  );
  log(`user approved intent mandate ${budget.id}: $5 for host 127.0.0.1, valid 1h (status ${budget.status})`);

  return { chain, rpcUrl: chain.rpcUrl, usdc, facilitator, payee, agent, budgetId: budget.id, publicClient, testClient, settlements, latenciesMs: [] };
}

async function teardown(env: Env): Promise<void> {
  await env.payee.close();
  await env.facilitator.stop();
  await env.chain.stop();
}

async function tokenBalance(env: Env, who: `0x${string}`): Promise<bigint> {
  return env.publicClient.readContract({ address: env.usdc, abi: EIP3009_ABI, functionName: 'balanceOf', args: [who] });
}

async function fetchOffer(env: Env, path: string, init?: RequestInit): Promise<{ status: number; required: PaymentRequired; bodyJson: unknown }> {
  const res = await fetch(`${env.payee.url}${path}`, init);
  const text = await res.text();
  const bodyJson = text ? JSON.parse(text) : undefined;
  const required = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '');
  return { status: res.status, required, bodyJson };
}

function lastLedgerEntry(env: Env) {
  const entries = new Ledger(resolve(OUT_DIR, 'ledger.jsonl')).read();
  return entries[entries.length - 1];
}

async function timedFetch(env: Env, path: string): Promise<Response> {
  const started = performance.now();
  const res = await env.agent.fetch(`${env.payee.url}${path}`);
  env.latenciesMs.push(performance.now() - started);
  return res;
}

// ------------------------------------------------------------ scenarios

async function scenarioHappy(env: Env): Promise<void> {
  heading('Scenario 1: pay for a call — settled on chain before the response arrives');
  const payerBefore = await tokenBalance(env, DEV.payer.address);
  const payeeBefore = await tokenBalance(env, DEV.payee.address);
  const res = await timedFetch(env, '/predict');
  const body = (await res.json()) as { symbol?: string };
  check(res.status === 200 && body.symbol === 'ETH-USD', `GET /predict answered 200 with a prediction (${env.latenciesMs.at(-1)!.toFixed(0)} ms incl. settlement)`);
  const settlement = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
  check(settlement.success && /^0x[0-9a-f]{64}$/.test(settlement.transaction), `PAYMENT-RESPONSE carries the settlement tx ${short(settlement.transaction)}`);
  const receipt = await env.publicClient.getTransactionReceipt({ hash: settlement.transaction as Hex });
  check(receipt.status === 'success' && receipt.from.toLowerCase() === DEV.facilitator.address.toLowerCase(), 'the tx was mined and sent by the facilitator (the payer paid no gas)');
  const payerAfter = await tokenBalance(env, DEV.payer.address);
  const payeeAfter = await tokenBalance(env, DEV.payee.address);
  check(payerBefore - payerAfter === 1000n && payeeAfter - payeeBefore === 1000n, `on-chain balances moved within the same call: payer -${formatUsdc(1000n)}, payee +${formatUsdc(1000n)}`);
  const entry = lastLedgerEntry(env);
  check(entry.status === 'settled' && entry.transaction === settlement.transaction, `ledger: settled, tx recorded (nonce ${short(entry.nonce)})`);
  const m = env.agent.getMandate(env.budgetId)!;
  check(m.spentAmount === '1000' && m.pendingSpentAmount === '0', `budget: spent ${formatUsdc(1000n)}, nothing pending`);
}

async function scenarioOffer(env: Env): Promise<void> {
  heading('Scenario 2: the 402 offer is x402 V2 (header), with an LLM hint in the body');
  const { status, required, bodyJson } = await fetchOffer(env, '/predict');
  const offer = required.accepts[0]!;
  check(status === 402, 'unauthenticated GET /predict -> 402');
  check(required.x402Version === 2 && required.resource.url === `${env.payee.url}/predict`, `PAYMENT-REQUIRED: x402Version 2, resource ${required.resource.url}`);
  check(offer.scheme === 'exact' && offer.network === NETWORK && offer.amount === '1000', `accepts[0]: scheme ${offer.scheme}, ${offer.network}, amount ${offer.amount}`);
  check(offer.extra.name === MOCK_USDC_DOMAIN.name && offer.extra.version === MOCK_USDC_DOMAIN.version, `extra names the token EIP-712 domain "${offer.extra.name}" v${offer.extra.version}`);
  check(offer.maxTimeoutSeconds === AUTH_VALIDITY, `maxTimeoutSeconds ${offer.maxTimeoutSeconds}: an authorization lives that long`);
  const hint = (bodyJson as { payment_model_context?: { reason?: string; commands?: string[] } })?.payment_model_context;
  check(hint?.reason === 'payment_required' && hint.commands?.includes('agentpay pay <url>'), 'body carries payment_model_context for an agent that reads it');
}

async function scenarioBudget(env: Env): Promise<void> {
  heading('Scenario 3: the budget refuses before anything is signed');
  const tiny = await env.agent.createIntentMandate(
    { naturalLanguage: 'three quotes only', limitAmount: '$0.003', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] },
    { approve: true },
  );
  const servedBefore = env.payee.served.predict;
  for (let i = 1; i <= 3; i++) {
    const res = await env.agent.fetch(`${env.payee.url}/predict`, undefined, { mandateId: tiny.id });
    check(res.status === 200, `call ${i} of 3 within the $0.003 budget -> 200`);
  }
  let refusal: unknown;
  try {
    await env.agent.fetch(`${env.payee.url}/predict`, undefined, { mandateId: tiny.id });
  } catch (err) {
    refusal = err;
  }
  check(refusal instanceof PolicyViolation && refusal.reason === 'mandate_insufficient_budget', 'call 4 refused client-side: PolicyViolation(mandate_insufficient_budget)');
  check((refusal as PolicyViolation).payment_model_context?.remediation.length! > 0, 'the refusal carries remediation for the agent');
  check(env.payee.served.predict === servedBefore + 3, 'the payee served exactly 3 calls');
  check(env.agent.remaining(tiny.id) === 0n, 'remaining budget on the tiny mandate: $0');
}

async function scenarioReplay(env: Env): Promise<void> {
  heading('Scenario 4: a settled authorization cannot be reused');
  const res = await env.agent.fetch(`${env.payee.url}/predict`);
  check(res.status === 200, 'a fresh paid call -> 200');
  const e = lastLedgerEntry(env);
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: (await fetchOffer(env, '/predict')).required.accepts[0]!,
    payload: { signature: e.signature, authorization: e.authorization },
  };
  const servedBefore = env.payee.served.predict;
  const replay = await fetch(`${env.payee.url}/predict`, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) } });
  const reason = decodePaymentRequiredHeader(replay.headers.get('PAYMENT-REQUIRED') ?? '').error;
  check(replay.status === 402 && reason === 'replay', `re-sending the same PAYMENT-SIGNATURE -> 402 ${reason} (refused by the payee, no facilitator call)`);
  check(env.payee.served.predict === servedBefore, 'the handler did not run again');
  const direct = await fetch(`${env.facilitator.url}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: payload.accepted }),
  });
  const verdict = (await direct.json()) as { isValid: boolean; invalidReason?: string };
  check(!verdict.isValid && verdict.invalidReason === 'invalid_exact_evm_nonce_already_used', `the facilitator itself says ${verdict.invalidReason} (the chain remembers the nonce)`);
}

async function scenarioFacilitatorReject(env: Env): Promise<void> {
  heading('Scenario 5: the facilitator refuses what the chain would refuse');
  const stranger = new MandateWallet({
    key: DEV.stranger.key,
    rpcUrl: env.rpcUrl,
    token: env.usdc,
    assetDomain: { ...MOCK_USDC_DOMAIN },
    network: NETWORK,
    ledgerPath: resolve(OUT_DIR, 'stranger-ledger.jsonl'),
  });
  await stranger.createIntentMandate({ naturalLanguage: 'stranger budget', limitAmount: '$1', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] }, { approve: true });
  const servedBefore = env.payee.served.predict;
  const res = await stranger.fetch(`${env.payee.url}/predict`);
  const reason = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED') ?? '').error;
  check(res.status === 402 && reason === 'invalid_exact_evm_insufficient_balance', `an agent with no USDC -> 402 ${reason}`);
  check(env.payee.served.predict === servedBefore, 'nothing was served');
  const strangerEntry = new Ledger(resolve(OUT_DIR, 'stranger-ledger.jsonl')).read()[0]!;
  check(strangerEntry.status === 'rejected', `the stranger's ledger says rejected; its budget stays reserved until the authorization expires (${AUTH_VALIDITY}s)`);

  // A tampered echo: the payer accepted terms that are not the route's.
  const { required } = await fetchOffer(env, '/predict');
  const e = lastLedgerEntry(env);
  const tampered: PaymentPayload = {
    x402Version: 2,
    accepted: { ...required.accepts[0]!, payTo: DEV.stranger.address },
    payload: { signature: e.signature, authorization: e.authorization },
  };
  const res2 = await fetch(`${env.payee.url}/predict`, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(tampered) } });
  check(res2.status === 402, 'a payment whose echoed terms differ from the offer (payTo) -> 402 before any facilitator call');
}

async function scenarioHandlerFailure(env: Env): Promise<void> {
  heading('Scenario 6: a handler that fails is never charged');
  env.payee.flaky.fail = true;
  const payerBefore = await tokenBalance(env, DEV.payer.address);
  const res = await env.agent.fetch(`${env.payee.url}/flaky`);
  check(res.status === 500, 'GET /flaky: the handler answered 500 after the payment was verified');
  check(!res.headers.has('PAYMENT-RESPONSE'), 'no PAYMENT-RESPONSE: the settlement was cancelled');
  check((await tokenBalance(env, DEV.payer.address)) === payerBefore, 'the payer balance is unchanged');
  const e = lastLedgerEntry(env);
  const m = env.agent.getMandate(env.budgetId)!;
  check(e.status === 'rejected' && BigInt(m.pendingSpentAmount) >= 1000n, 'ledger: rejected; the budget stays reserved because the signed authorization is still valid');
  env.payee.flaky.fail = false;
  const again = await env.agent.fetch(`${env.payee.url}/flaky`);
  check(again.status === 200 && again.headers.has('PAYMENT-RESPONSE'), 'once the handler works, a fresh authorization pays and settles');
}

async function scenarioConcurrency(env: Env): Promise<void> {
  heading('Scenario 7: twenty concurrent paid calls, twenty settlement transactions');
  const n = 20;
  const spentBefore = BigInt(env.agent.getMandate(env.budgetId)!.spentAmount);
  const nonceBefore = await env.publicClient.getTransactionCount({ address: DEV.facilitator.address });
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => env.agent.fetch(`${env.payee.url}/predict`)));
  const elapsed = performance.now() - started;
  const ok = results.filter((r) => r.status === 200).length;
  const txs = new Set(results.map((r) => decodePaymentResponseHeader(r.headers.get('PAYMENT-RESPONSE') ?? '').transaction));
  check(ok === n, `${ok}/${n} calls answered 200 in ${elapsed.toFixed(0)} ms`);
  check(txs.size === n, `${txs.size} distinct settlement transactions`);
  check(BigInt(env.agent.getMandate(env.budgetId)!.spentAmount) === spentBefore + 1000n * BigInt(n), `budget spent exactly ${n} × $0.001, nothing pending`);
  const nonceAfter = await env.publicClient.getTransactionCount({ address: DEV.facilitator.address });
  check(nonceAfter === nonceBefore + n, `the facilitator's account nonce advanced by exactly ${n} (send lock + nonce manager)`);
}

async function scenarioLatency(env: Env): Promise<void> {
  heading('Scenario 8: per-call latency on this machine (hardhat automine; expect ~2-4 s on Base)');
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const res = await env.agent.fetch(`${env.payee.url}/predict`);
    samples.push(performance.now() - started);
    if (res.status !== 200) failures.push(`latency: call ${i} answered ${res.status}`);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  check(samples.length === 10, `10 sequential paid calls: min ${samples[0]!.toFixed(0)} ms · avg ${avg.toFixed(0)} ms · max ${samples[9]!.toFixed(0)} ms (402 + verify + handler + settle + receipt)`);
}

async function scenarioInterop(env: Env): Promise<void> {
  heading('Scenario 9: the official @x402/fetch client pays this payee too');
  const client = new x402Client().setSpendControls(false); // MockUSDC is not one of the client's default assets
  registerExactEvmScheme(client, { signer: privateKeyToAccount(DEV.payer.key) });
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const payerBefore = await tokenBalance(env, DEV.payer.address);
  const res = await paidFetch(`${env.payee.url}/predict`);
  const settlement = decodePaymentResponseHeader(res.headers.get('PAYMENT-RESPONSE') ?? '');
  check(res.status === 200 && settlement.success, `@x402/fetch + @x402/evm (no agentpay code on the client side) -> 200, tx ${short(settlement.transaction)}`);
  check((await tokenBalance(env, DEV.payer.address)) === payerBefore - 1000n, 'settled through our facilitator: payer -$0.001');
}

async function scenarioExpiry(env: Env): Promise<void> {
  heading('Scenario 10 (last: time travel): an authorization that was refused expires by chain time and frees its budget');
  env.payee.flaky.fail = true;
  const res = await env.agent.fetch(`${env.payee.url}/flaky`);
  env.payee.flaky.fail = false;
  const e = lastLedgerEntry(env);
  check(res.status === 500 && e.status === 'rejected', 'a refused call left a rejected row with its budget reserved');
  const pendingBefore = BigInt(env.agent.getMandate(env.budgetId)!.pendingSpentAmount);
  const early = await env.agent.reconcile();
  check(early.stillPending.includes(e.nonce), 'reconcile() before validBefore: still pending (the payee could still settle it)');
  await env.testClient.increaseTime({ seconds: AUTH_VALIDITY + 1 });
  await env.testClient.mine({ blocks: 1 });
  const late = await env.agent.reconcile();
  check(late.expiredUnused.includes(e.nonce), `reconcile() after chain time passed validBefore: expired-unused`);
  const pendingAfter = BigInt(env.agent.getMandate(env.budgetId)!.pendingSpentAmount);
  // Scenario 6's first refused call expires here too: every reservation is gone.
  check(pendingAfter === 0n && pendingBefore >= 1000n, `every held reservation is released (pending ${formatUsdc(pendingBefore)} -> ${formatUsdc(pendingAfter)})`);
  check(late.verified.length > 0, `${late.verified.length} earlier settlements confirmed on chain (nonce used) now that their validity ended`);
}

// ------------------------------------------------------------ main

const SCENARIOS: Record<string, (env: Env) => Promise<void>> = {
  happy: scenarioHappy,
  offer: scenarioOffer,
  budget: scenarioBudget,
  replay: scenarioReplay,
  'facilitator-reject': scenarioFacilitatorReject,
  'handler-failure': scenarioHandlerFailure,
  concurrency: scenarioConcurrency,
  latency: scenarioLatency,
  interop: scenarioInterop,
  expiry: scenarioExpiry,
};

async function main(): Promise<void> {
  const only = parseOnly(process.argv.slice(2));
  if (only && !SCENARIOS[only]) {
    console.error(`unknown scenario ${only}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  const env = await setup();
  try {
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      if (only && name !== only) continue;
      currentScenario = name;
      await fn(env);
    }
  } finally {
    heading('Summary');
    const report = env.agent.report();
    const avg = env.latenciesMs.length ? env.latenciesMs.reduce((a, b) => a + b, 0) / env.latenciesMs.length : 0;
    log(`paid calls      : ${report.totals.settled} settled · ${report.totals.rejected} rejected · ${report.totals.expiredUnused} expired unused`);
    log(`agent spend     : ${formatUsdc(BigInt(report.totals.spent))} (pending ${formatUsdc(BigInt(report.totals.pending))})`);
    log(`settlement txs  : ${env.settlements.length} by the facilitator, one per paid call`);
    log(`policy denials  : ${report.policyDenials.length}`);
    log(`ledger          : ${resolve(OUT_DIR, 'ledger.jsonl')}`);
    if (avg) log(`avg latency     : ${avg.toFixed(0)} ms per timed call`);
    await teardown(env);
  }
  console.log();
  if (failures.length > 0) {
    console.log(`FAILED ASSERTIONS (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL SCENARIO ASSERTIONS PASSED');
  // Exit explicitly once stdout has drained: the failure paths already do, and a
  // handle left open by a stopped child must not keep a passed run hanging
  // (the e2e test waits for this process to close, not for the line above).
  process.stdout.write('', () => process.exit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
