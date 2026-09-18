/**
 * End-to-end demo: a fresh local chain, the debit wallet, a settlement
 * processor, a paid API, and an agent wallet with a user-approved budget.
 *
 *   npm run demo                # all scenarios
 *   npm run demo -- --only batch
 *
 * Exit code 0 iff every scenario's assertions pass.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { AEP2_DEBIT_WALLET_ABI, MOCK_USDC_ABI, deployAll } from '@agentpay/contracts';
import {
  HEADER,
  PolicyViolation,
  encodeHeader,
  formatUsdc,
  mandateDigest,
  randomNonce,
  readPaymentRequired,
  readPaymentResponse,
  resourceRef,
  signMandate,
  verifySpReceipt,
  type Hex,
  type Mandate,
  type PaymentRequirements,
} from '@agentpay/core';
import { Ledger, MandateWallet } from '@agentpay/wallet';
import { DEV } from './accounts.js';
import { startChain, type ChainHandle } from './chain.js';
import { startPayee, type PayeeHandle } from './payee.js';
import { startSp } from './sp.js';
import { parseOnly, short } from './util.js';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const CHAIN_PORT = 8545;
const SP_PORT = 3001;
const PAYEE_PORT = 4021;
const WITHDRAW_DELAY = 600; // seconds (demo); production: hours
const SETTLE_WINDOW = 300; // seconds (demo); must be <= WITHDRAW_DELAY
const NETWORK = 'eip155:31337';

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
  wallet: `0x${string}`;
  sp: Awaited<ReturnType<typeof startSp>>;
  payee: PayeeHandle;
  agent: MandateWallet;
  budgetId: string;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  settlementTxs: { hash: Hex; count: number; gas: bigint }[];
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

  const { usdc, wallet } = await deployAll(deployer, publicClient, { withdrawDelay: WITHDRAW_DELAY });
  log(`MockUSDC ${short(usdc)} · AEP2DebitWallet ${short(wallet)} (withdrawDelay ${WITHDRAW_DELAY}s)`);
  for (const to of [DEV.payer.address]) {
    const hash = await deployer.writeContract({ address: usdc, abi: MOCK_USDC_ABI, functionName: 'mint', args: [to, parseUnits('10000', 6)] });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const sp = await startSp({
    rpcUrl: chain.rpcUrl,
    chainId: hardhat.id,
    key: DEV.sp.key,
    wallet,
    usdc,
    port: SP_PORT,
    storePath: resolve(OUT_DIR, 'sp-queue.jsonl'),
    settleWindowSeconds: SETTLE_WINDOW,
  });
  log(`settlement processor ${short(DEV.sp.address)} on ${sp.url} (settle window ${SETTLE_WINDOW}s, manual batching)`);

  const payee = await startPayee({
    port: PAYEE_PORT,
    rpcUrl: chain.rpcUrl,
    network: NETWORK,
    asset: usdc,
    payTo: DEV.payee.address,
    wallet,
    sp: { url: sp.url, address: DEV.sp.address, settleWindowSeconds: SETTLE_WINDOW },
  });
  log(`payee ${short(DEV.payee.address)} on ${payee.url}: GET /predict $0.001 · POST /analyze $0.01`);

  const agent = new MandateWallet({
    key: DEV.payer.key,
    rpcUrl: chain.rpcUrl,
    walletContract: wallet,
    token: usdc,
    network: NETWORK,
    mandatesPath: resolve(OUT_DIR, 'mandates.json'),
    ledgerPath: resolve(OUT_DIR, 'ledger.jsonl'),
  });
  await agent.deposit(parseUnits('10', 6));
  await agent.authorizeSP(DEV.sp.address);
  log(`agent ${short(agent.address)} deposited $10 and authorized the SP; debitable ${formatUsdc(await agent.debitable())}`);

  const budget = await agent.createIntentMandate(
    { naturalLanguage: 'Market data and text analysis for the demo', limitAmount: '$5', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] },
    { approve: true },
  );
  log(`user approved intent mandate ${budget.id}: $5 for host 127.0.0.1, valid 1h (status ${budget.status})`);

  return { chain, rpcUrl: chain.rpcUrl, usdc, wallet, sp, payee, agent, budgetId: budget.id, publicClient, testClient, settlementTxs: [] };
}

async function teardown(env: Env): Promise<void> {
  await env.payee.close();
  await env.sp.stop();
  await env.chain.stop();
}

async function payerBalance(env: Env): Promise<bigint> {
  return env.publicClient.readContract({ address: env.wallet, abi: AEP2_DEBIT_WALLET_ABI, functionName: 'balances', args: [DEV.payer.address, env.usdc] });
}

async function tokenBalance(env: Env, who: `0x${string}`): Promise<bigint> {
  return env.publicClient.readContract({ address: env.usdc, abi: MOCK_USDC_ABI, functionName: 'balanceOf', args: [who] });
}

async function fetchOffer(env: Env, path: string, init?: RequestInit): Promise<{ status: number; offer: PaymentRequirements; headerJson: unknown; bodyJson: unknown }> {
  const res = await fetch(`${env.payee.url}${path}`, init);
  const text = await res.text();
  const bodyJson = JSON.parse(text);
  const headerJson = readPaymentRequired(res.headers);
  const offer = readPaymentRequired(res.headers, text).accepts[0];
  return { status: res.status, offer, headerJson, bodyJson };
}

// ------------------------------------------------------------ scenarios

async function scenarioHappy(env: Env): Promise<void> {
  heading('Scenario 1 — happy path: GET /predict for $0.001');
  const balanceBefore = await payerBalance(env);
  const t0 = Date.now();
  const res = await env.agent.fetch(`${env.payee.url}/predict`);
  const body = (await res.json()) as { symbol: string; price: number };
  const info = readPaymentResponse(res.headers);
  check(res.status === 200, `200 in ${Date.now() - t0}ms: ${JSON.stringify(body)}`);
  check(info?.status === 'enqueued' && info.spReceipt.sp.toLowerCase() === DEV.sp.address.toLowerCase(), `PAYMENT-RESPONSE: enqueued by SP ${short(info?.spReceipt.sp ?? '')}, digest ${short(info?.mandateDigest ?? '')}`);
  if (info) {
    const verdict = await verifySpReceipt(info.spReceipt, {
      domain: { chainId: hardhat.id, verifyingContract: env.wallet },
      expectedSp: DEV.sp.address,
      mandateDigest: info.mandateDigest,
      now: Math.floor(Date.now() / 1000),
      maxWindowSeconds: SETTLE_WINDOW + 60,
    });
    check(verdict.ok, `SP receipt verifies (settle by +${info.spReceipt.enqueueDeadline - Math.floor(Date.now() / 1000)}s)`);
    const status = (await (await fetch(`${env.sp.url}/status/${info.mandateDigest}`)).json()) as { status: string };
    check(status.status === 'pending', `SP queue status: ${status.status}`);
  }
  const entry = env.agent.report();
  const m = entry.mandates.find((x) => x.id === env.budgetId);
  check(m?.spentAmount === '1000', `intent mandate spent ${formatUsdc(BigInt(m?.spentAmount ?? '0'))}, remaining ${formatUsdc(BigInt(m?.remainingAmount ?? '0'))}`);
  check((await payerBalance(env)) === balanceBefore, `on-chain balance unchanged (${formatUsdc(balanceBefore)}) — settlement is deferred`);
}

async function scenarioOffer(env: Env): Promise<void> {
  heading('Scenario 2 — no payment header: the 402 offer');
  const { status, offer, headerJson, bodyJson } = await fetchOffer(env, '/predict');
  check(status === 402, `raw GET /predict -> ${status}`);
  check(JSON.stringify(headerJson) === JSON.stringify(bodyJson), 'PAYMENT-REQUIRED header JSON equals the body JSON');
  check(offer.scheme === 'aep2' && offer.network === NETWORK && offer.amount === '1000', `offer: scheme ${offer.scheme}, ${offer.network}, amount ${offer.amount} (=$0.001)`);
  check(offer.extra.wallet.toLowerCase() === env.wallet.toLowerCase() && offer.extra.spAddress.toLowerCase() === DEV.sp.address.toLowerCase(), `offer.extra: wallet ${short(offer.extra.wallet)}, sp ${offer.extra.sp}, settle window ${offer.extra.settleWindowSeconds}s`);
  check(typeof (bodyJson as { payment_model_context?: unknown }).payment_model_context === 'object', 'body carries payment_model_context for LLM agents');
}

async function scenarioBudget(env: Env): Promise<void> {
  heading('Scenario 3 — budget exhausted: a $0.003 mandate pays 3 calls, refuses the 4th');
  const tiny = await env.agent.createIntentMandate(
    { naturalLanguage: 'Three quotes only', limitAmount: '$0.003', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] },
    { approve: true },
  );
  const servedBefore = env.payee.served.predict;
  for (let i = 1; i <= 3; i++) {
    const res = await env.agent.fetch(`${env.payee.url}/predict`, undefined, { mandateId: tiny.id });
    check(res.status === 200, `call ${i}: ${res.status}, remaining ${formatUsdc(env.agent.remaining(tiny.id))}`);
  }
  try {
    await env.agent.fetch(`${env.payee.url}/predict`, undefined, { mandateId: tiny.id });
    check(false, 'call 4 should have been refused');
  } catch (err) {
    const pv = err as PolicyViolation;
    check(err instanceof PolicyViolation && pv.reason === 'mandate_insufficient_budget', `call 4 refused before signing: ${pv.reason}`);
    log(`hint for the agent: ${pv.payment_model_context?.summary}`);
    log(`  -> ${pv.payment_model_context?.remediation[0]}`);
  }
  check(env.payee.served.predict === servedBefore + 3, 'payee served exactly 3 calls');
}

async function scenarioReplay(env: Env): Promise<void> {
  heading('Scenario 4 — replaying an already-used mandate');
  const last = new Ledger(resolve(OUT_DIR, 'ledger.jsonl')).read().at(-1);
  if (!last) {
    check(false, 'ledger has entries');
    return;
  }
  const { offer } = await fetchOffer(env, '/predict');
  const servedBefore = env.payee.served.predict;
  const res = await fetch(`${env.payee.url}/predict`, {
    headers: { [HEADER.signature]: encodeHeader({ x402Version: 2, accepted: offer, payload: { mandate: last.mandate, payerSig: last.payerSig } }) },
  });
  const body = (await res.json()) as { error?: string };
  check(res.status === 409 && body.error === 'replay', `re-sent mandate ${short(last.mandateDigest)} -> ${res.status} ${body.error}`);
  check(env.payee.served.predict === servedBefore, 'handler did not run');
}

async function scenarioSpReject(env: Env): Promise<void> {
  heading('Scenario 5 — the settlement processor refuses');
  const stranger = new MandateWallet({
    key: DEV.stranger.key,
    rpcUrl: env.rpcUrl,
    walletContract: env.wallet,
    token: env.usdc,
    network: NETWORK,
    ledgerPath: resolve(OUT_DIR, 'stranger-ledger.jsonl'),
  });
  await stranger.createIntentMandate({ naturalLanguage: 'stranger budget', limitAmount: '$1', validForSeconds: 3600, hostAllowlist: ['127.0.0.1'] }, { approve: true });
  const analyze = (w: MandateWallet) =>
    w.fetch(`${env.payee.url}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello world!' }) });

  let res = await analyze(stranger);
  let body = (await res.json()) as { error?: string };
  check(res.status === 402 && (body.error ?? '').startsWith('settlement_unavailable') && (body.error ?? '').includes('sp_not_authorized'), `stranger never authorized the SP -> ${res.status} ${body.error}`);

  await stranger.authorizeSP(DEV.sp.address);
  res = await analyze(stranger);
  body = (await res.json()) as { error?: string };
  check(res.status === 402 && (body.error ?? '').includes('insufficient_balance'), `authorized but never deposited -> ${res.status} ${body.error}`);

  // A mandate that leaves the SP no time to settle is refused straight at /enqueue.
  const now = Math.floor(Date.now() / 1000);
  const mandate: Mandate = { owner: DEV.payer.address, token: env.usdc, payee: DEV.payee.address, amount: '1000', nonce: randomNonce(), deadline: now + 10, ref: resourceRef('GET /predict') };
  const payerSig = await signMandate(privateKeyToAccount(DEV.payer.key), { chainId: hardhat.id, verifyingContract: env.wallet }, mandate);
  const enq = await fetch(`${env.sp.url}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mandate, payerSig }) });
  const enqBody = (await enq.json()) as { error?: string };
  check(enq.status === 400 && enqBody.error === 'deadline_too_soon', `mandate expiring in 10s straight to SP /enqueue -> ${enq.status} ${enqBody.error}`);
}

async function scenarioBatch(env: Env): Promise<void> {
  heading('Scenario 6 — 20 calls, one settlement transaction');
  const payerBefore = await payerBalance(env);
  const payeeBefore = await tokenBalance(env, DEV.payee.address);
  const pendingBefore = ((await (await fetch(`${env.sp.url}/health`)).json()) as { counts: { pending: number } }).counts.pending;
  for (let i = 0; i < 20; i++) {
    const res = await env.agent.fetch(`${env.payee.url}/predict`);
    if (res.status !== 200) check(false, `call ${i + 1} returned ${res.status}`);
  }
  const health = (await (await fetch(`${env.sp.url}/health`)).json()) as { counts: { pending: number } };
  check(health.counts.pending === pendingBefore + 20, `SP queue holds ${health.counts.pending} pending mandates`);

  const tick = await env.sp.tick();
  const receipt = tick.txHash ? await env.publicClient.getTransactionReceipt({ hash: tick.txHash }) : undefined;
  check(tick.txHash !== undefined && tick.settled.length >= 20, `one settleBatch tx ${short(tick.txHash ?? '')} settled ${tick.settled.length} mandates, skipped ${tick.skipped.length}`);
  if (receipt) {
    env.settlementTxs.push({ hash: receipt.transactionHash, count: tick.settled.length, gas: receipt.gasUsed });
    log(`gas used ${receipt.gasUsed} (${receipt.gasUsed / BigInt(Math.max(1, tick.settled.length))} per mandate)`);
  }
  const payerAfter = await payerBalance(env);
  const payeeAfter = await tokenBalance(env, DEV.payee.address);
  check(payerAfter === payerBefore - 1000n * BigInt(tick.settled.length), `payer balance ${formatUsdc(payerBefore)} -> ${formatUsdc(payerAfter)}`);
  check(payeeAfter === payeeBefore + 1000n * BigInt(tick.settled.length), `payee received ${formatUsdc(payeeAfter - payeeBefore)} USDC on-chain`);

  const rec = await env.agent.reconcile();
  check(rec.settled.length >= 20, `agent reconcile(): ${rec.settled.length} ledger entries now settled, ${rec.stillPending.length} pending`);
}

async function scenarioWithdrawLock(env: Env): Promise<void> {
  heading('Scenario 7 — the withdrawal delay protects an in-flight mandate');
  const res = await env.agent.fetch(`${env.payee.url}/predict`);
  check(res.status === 200, 'one more paid call is enqueued');
  const balance = await payerBalance(env);
  const tx = await env.agent.requestWithdraw(balance);
  check(typeof tx === 'string', `agent requests withdrawal of its whole balance ${formatUsdc(balance)} (tx ${short(tx)})`);
  check((await env.agent.debitable()) === 0n, 'debitable balance is now 0: the SP would admit no NEW mandate');
  try {
    await env.agent.executeWithdraw();
    check(false, 'immediate executeWithdraw should revert');
  } catch (err) {
    check(/WithdrawalLocked/.test(String((err as Error).message)), 'immediate executeWithdraw reverts: WithdrawalLocked');
  }
  const tick = await env.sp.tick();
  check(tick.settled.length >= 1, `SP still settles the in-flight mandate during the delay (${tick.settled.length} settled)`);
  if (tick.txHash) {
    const receipt = await env.publicClient.getTransactionReceipt({ hash: tick.txHash });
    env.settlementTxs.push({ hash: receipt.transactionHash, count: tick.settled.length, gas: receipt.gasUsed });
  }
  await env.testClient.increaseTime({ seconds: WITHDRAW_DELAY + 1 });
  await env.testClient.mine({ blocks: 1 });
  const before = await tokenBalance(env, DEV.payer.address);
  await env.agent.executeWithdraw();
  const after = await tokenBalance(env, DEV.payer.address);
  const expected = balance - 1000n * BigInt(tick.settled.length);
  check(after - before === expected, `after the delay the withdrawal pays out only the remainder: ${formatUsdc(after - before)} (requested ${formatUsdc(balance)})`);
  check((await payerBalance(env)) === 0n, 'debit-wallet balance is 0');
}

// ------------------------------------------------------------ main

const SCENARIOS: Record<string, (env: Env) => Promise<void>> = {
  happy: scenarioHappy,
  offer: scenarioOffer,
  budget: scenarioBudget,
  replay: scenarioReplay,
  'sp-reject': scenarioSpReject,
  batch: scenarioBatch,
  'withdraw-lock': scenarioWithdrawLock,
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
    const txs = env.settlementTxs;
    const gas = txs.reduce((a, t) => a + t.gas, 0n);
    const settledCount = txs.reduce((a, t) => a + t.count, 0);
    log(`paid calls      : ${report.totals.enqueued + report.totals.settled}`);
    log(`agent spend     : ${formatUsdc(BigInt(report.totals.spent))}`);
    log(`settlement txs  : ${txs.length} (${settledCount} mandates, avg gas/mandate ${settledCount ? gas / BigInt(settledCount) : 0n})`);
    log(`policy denials  : ${report.policyDenials.length}`);
    log(`ledger          : ${resolve(OUT_DIR, 'ledger.jsonl')}`);
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
