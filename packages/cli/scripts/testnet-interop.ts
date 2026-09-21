/**
 * Base Sepolia interop probe: this wallet against payees it did not write.
 *
 *   AGENTPAY_HOME=.local/base-sepolia npm run interop:testnet --workspace @agentpay/cli
 *
 * Runs the CLI's own command handlers in process (the same code path a host's
 * wallet tools take) against strangers on the public testnet — PayAI's echo,
 * omniterminal's market snapshot, optionally INTEROP_EXTRA_URL — and writes
 * what happened to docs/interop/testnet-interop-<date>.json. It ASSERTS
 * NOTHING: a stranger that refuses, answers an odd PAYMENT-RESPONSE or
 * settles late is a finding to record, not a failure to hide, so every step
 * catches and reports (the CLI's own error envelope) and the exit code only
 * says whether the report was written.
 *
 * Guard rails: the resolved network must be eip155:84532 (this spends real
 * test USDC through a real facilitator and the payees are mainnet-listed too;
 * a mainnet home here would spend real money — exit 2 'testnet only'), and
 * the home must not be locked by a running wallet (a CLI write beside one is
 * silently dropped, see cli.ts MUTATING). The RPC defaults to
 * https://sepolia.base.org through resolveConfig (AGENTPAY_RPC overrides).
 *
 * Env: INTEROP_OUT (report path), INTEROP_SAVE=1 (pay --save into a temp dir,
 * proving a stranger's bytes land on disk unchanged), INTEROP_EXTRA_URL (a
 * third GET target, e.g. a vendor-sim on Sepolia), INTEROP_CONCURRENCY (3).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { formatUsdc } from '@agentpay/core';
import { PRINCIPAL, lockedBy, type IntentMandate, type MandateWallet } from '@agentpay/wallet';
import { ConfigError, resolveConfig, type CliConfig } from '../src/config.js';
import { CommandContext } from '../src/context.js';
import { failure, toJson, type CliResult } from '../src/output.js';
import { mandateCreate } from '../src/commands/mandate.js';
import { offer, pay } from '../src/commands/pay.js';
import { reconcile } from '../src/commands/ledger.js';

export const TESTNET = 'eip155:84532';
/** The wallet's own authorization-validity cap (MandateWallet DEFAULT_MAX_AUTHORIZATION_VALIDITY): an offer above it is refused as timeout_too_long. */
export const MAX_TIMEOUT_SECONDS = 300;
export const DISCOVER_QUERY = 'market snapshot BTC';
export const MANDATE = {
  purpose: 'testnet interop',
  limit: '0.10',
  perCall: '0.01',
  validFor: 1800,
  hosts: ['x402.payai.network', 'omniterminal.app', '127.0.0.1'],
} as const;

export interface Target {
  name: string;
  url: string;
  method?: string;
}

export const DEFAULT_TARGETS: readonly Target[] = [
  { name: 'payai-echo', url: 'https://x402.payai.network/api/base-sepolia/paid-content' },
  { name: 'omniterminal-btc', url: 'https://omniterminal.app/api/x402/v1/market-snapshot/BTC' },
];

/** One row of an offer's `accepts`, projected to what a reader compares across payees. */
export interface AcceptSummary {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  amount_usd: string | null;
  pay_to: string;
  max_timeout_s: number | null;
}

export interface OfferResult {
  status: number | null;
  latency_ms: number;
  accepts: AcceptSummary[];
  /** Every offer for our network fits under the wallet's 300 s cap (false when none does, or none is for our network). */
  timeout_ok: boolean | null;
  error?: unknown;
}

export interface PayResult {
  status: number | null;
  latency_ms: number;
  /** Atomic USDC the ledger recorded (what totals sum); `amount_usd` is the same figure for a reader. */
  amount: string | null;
  amount_usd: string | null;
  tx: string | null;
  /** The ledger row's status: the handler reports it on a 2xx; on a refusal it is read from the row the wallet wrote (null under the concurrent burst, where rows cannot be matched). */
  ledger_status: string | null;
  error?: unknown;
  body_bytes: number | null;
  saved?: unknown;
  /** The payee's PAYMENT-RESPONSE as the ledger saw it (payer/network/success), or what the wallet recorded instead. */
  settlement: { payer: string | null; network: string | null } | null;
}

export interface ChainResult {
  /** `getTransaction(tx).from`: the facilitator's signer (who paid gas), not the payer. */
  tx_from: string | null;
  /** The payer the payee reported in PAYMENT-RESPONSE; should be this wallet's address. */
  settlement_payer: string | null;
  payer_is_wallet: boolean | null;
  error?: string;
}

export interface TargetResult {
  name: string;
  url: string;
  method: string;
  offer: OfferResult;
  pay: PayResult;
  chain: ChainResult | null;
}

export interface InteropReport {
  version: 1;
  date: string;
  network: string;
  rpc: string | null;
  payer: string;
  home: string;
  discovery:
    | { skipped: true; reason: string }
    | { skipped: false; query: string; matched: number | null; payable: number | null; top: unknown[]; error?: unknown };
  mandate: { id: string; created: boolean; remaining_usd: string; valid_until: string; hosts: readonly string[] };
  targets: TargetResult[];
  concurrent: { url: string; n: number; latency_ms: number; results: PayResult[] };
  reconcile: { counts?: Record<string, number>; error?: unknown };
  /** Ledger rows this run added: what the wallet's books say, independent of how the calls were reported. */
  ledger: { rows_added: number; by_status: Record<string, number>; settled_usd: string; reserved_usd: string };
  totals: { paid: number; refused: number; spent_usd: string };
  notes: string[];
}

export type Discover = (ctx: CommandContext, query: string) => Promise<CliResult>;

export interface InteropDeps {
  ctx: CommandContext;
  config: CliConfig;
  targets: readonly Target[];
  /** Absent when the tree has no `discover` command yet (the report says so). */
  discover?: Discover;
  /** `getTransaction(hash).from`; injected so the suites run without a chain. */
  txFrom: (hash: Hex) => Promise<string>;
  /** Pay with `--save` into this directory (a temp dir under INTEROP_SAVE=1). */
  saveRoot?: string;
  concurrency: number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * resolveConfig plus the two refusals that make this script safe to point at
 * any home: a non-testnet network and a locked home both exit 2 before a
 * single request leaves. Exported so the suite can check both without a chain.
 */
export function guard(env: NodeJS.ProcessEnv): CliConfig {
  const config = resolveConfig({}, env);
  if (config.network !== TESTNET) throw new ConfigError(`testnet only: this script runs against ${TESTNET}, the home resolves to ${config.network}`);
  const pid = lockedBy(config.home);
  if (pid !== undefined) throw new ConfigError(`wallet home ${config.home} is locked by pid ${pid}: stop that wallet first`);
  return config;
}

/**
 * The offer rows a reader compares across payees: never the whole
 * PaymentRequirements (extra/description/outputSchema vary per payee and
 * bloat the report). `amount_usd` assumes a 6-decimal asset, which is what
 * every USDC offer is; a stranger offering something else shows null.
 */
export function summarizeAccepts(accepts: unknown): AcceptSummary[] {
  if (!Array.isArray(accepts)) return [];
  return accepts.map((o) => {
    const x = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>;
    const amount = typeof x.amount === 'string' ? x.amount : String(x.amount ?? '');
    return {
      scheme: String(x.scheme ?? ''),
      network: String(x.network ?? ''),
      asset: String(x.asset ?? ''),
      amount,
      amount_usd: /^\d+$/.test(amount) ? formatUsdc(BigInt(amount)) : null,
      pay_to: String(x.payTo ?? ''),
      max_timeout_s: typeof x.maxTimeoutSeconds === 'number' ? x.maxTimeoutSeconds : null,
    };
  });
}

/** True when at least one offer for `network` exists and all of them fit under the wallet's cap. */
export function timeoutOk(accepts: AcceptSummary[], network: string): boolean | null {
  const ours = accepts.filter((a) => a.network === network);
  if (ours.length === 0) return null;
  return ours.every((a) => a.max_timeout_s !== null && a.max_timeout_s <= MAX_TIMEOUT_SECONDS);
}

/** UTF-8 size of what the payee sent: exact for a saved or string body, the re-serialised size for a parsed JSON one. */
export function bodyBytes(out: Record<string, unknown>): number | null {
  const saved = out.saved as { bytes?: number } | undefined;
  if (saved && typeof saved.bytes === 'number') return saved.bytes;
  if (!('body' in out)) return null;
  const body = out.body;
  return Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body) ?? '', 'utf8');
}

const ms = (t0: number): number => Math.round(performance.now() - t0);

/** The error envelope the CLI would print, so a refusal reads the same here as on the command line. */
function errorOf(err: unknown): unknown {
  return failure(err).output;
}

async function probeOffer(deps: InteropDeps, t: Target): Promise<OfferResult> {
  const t0 = performance.now();
  try {
    const r = await offer(deps.ctx, [t.url], { method: t.method });
    const out = r.output as Record<string, unknown>;
    const accepts = summarizeAccepts(out.offer);
    return { status: (out.status as number) ?? null, latency_ms: ms(t0), accepts, timeout_ok: timeoutOk(accepts, deps.config.network) };
  } catch (err) {
    return { status: null, latency_ms: ms(t0), accepts: [], timeout_ok: null, error: errorOf(err) };
  }
}

/** `alone`: no other pay to this URL is in flight, so a refusal's ledger row can be matched (never under the concurrent burst). */
async function doPay(deps: InteropDeps, t: Target, saveAs?: string, alone = true): Promise<PayResult> {
  const t0 = performance.now();
  const before = new Set(deps.ctx.ledger().read().map((e) => e.nonce));
  try {
    const r = await pay(deps.ctx, [t.url], {
      method: t.method,
      ...(saveAs && deps.saveRoot ? { save: saveAs, saveRoot: deps.saveRoot, overwrite: true } : {}),
    });
    const out = r.output as Record<string, unknown>;
    const p = (out.payment ?? null) as Record<string, unknown> | null;
    return {
      status: (out.status as number) ?? null,
      latency_ms: ms(t0),
      amount: typeof p?.amount === 'string' ? p.amount : null,
      amount_usd: typeof p?.amount === 'string' ? formatUsdc(BigInt(p.amount)) : null,
      tx: (p?.transaction as string | null) ?? null,
      ledger_status: (p?.ledgerStatus as string) ?? null,
      ...(p?.error ? { error: p.error } : {}),
      body_bytes: bodyBytes(out),
      ...(out.saved ? { saved: out.saved } : {}),
      settlement: p ? { payer: (p.payer as string) ?? null, network: (p.network as string) ?? null } : null,
    };
  } catch (err) {
    const env = errorOf(err) as Record<string, unknown>;
    // A refusal after signing still left a row (rejected: budget stays reserved until reconcile);
    // a policy denial or a dead host left none. Concurrent pays to one URL cannot be told apart here.
    const rows = alone ? deps.ctx.ledger().read().filter((e) => !before.has(e.nonce) && e.url === t.url) : [];
    const row = rows.length === 1 ? rows[0] : undefined;
    return {
      status: typeof env.status === 'number' ? env.status : null,
      latency_ms: ms(t0),
      amount: row?.amount ?? null,
      amount_usd: row ? formatUsdc(BigInt(row.amount)) : null,
      tx: row?.transaction ?? null,
      ledger_status: row?.status ?? null,
      error: env,
      body_bytes: null,
      settlement: null,
    };
  }
}

async function checkChain(deps: InteropDeps, p: PayResult): Promise<ChainResult | null> {
  if (!p.tx) return null;
  const wallet = deps.ctx.wallet();
  const payer = p.settlement?.payer ?? null;
  const base = { settlement_payer: payer, payer_is_wallet: payer ? payer.toLowerCase() === wallet.address.toLowerCase() : null };
  try {
    return { tx_from: await deps.txFrom(p.tx as Hex), ...base };
  } catch (err) {
    return { tx_from: null, ...base, error: (err as Error).message };
  }
}

/**
 * The signed, enabled, principal-held mandate that names every interop host
 * with budget left for a full-price call — the wallet's own eligibility rule
 * per host, intersected — or a fresh one. Reusing avoids a new $0.10 budget
 * per run; the ledger attributes every run to it.
 */
export async function findOrCreateMandate(wallet: MandateWallet, ctx: CommandContext): Promise<{ mandate: IntentMandate; created: boolean }> {
  const perCall = 10_000n; // $0.01 in atomic USDC
  let ids: Set<string> | undefined;
  for (const host of MANDATE.hosts) {
    const eligible = new Set(wallet.eligibleMandates({ host, amount: perCall, caller: PRINCIPAL }).eligible.map((m) => m.id));
    ids = ids ? new Set([...ids].filter((id) => eligible.has(id))) : eligible;
  }
  const existing = [...(ids ?? [])].map((id) => wallet.getMandate(id)).find((m): m is IntentMandate => !!m && m.holder === undefined);
  if (existing) return { mandate: existing, created: false };
  const r = await mandateCreate(ctx, [], {
    purpose: MANDATE.purpose,
    limit: MANDATE.limit,
    'per-call': MANDATE.perCall,
    'valid-for': String(MANDATE.validFor),
    hosts: MANDATE.hosts.join(','),
  });
  const id = ((r.output as { mandate: { id: string } }).mandate).id;
  return { mandate: wallet.getMandate(id)!, created: true };
}

/** Discovery through whatever `discover` the tree has; the top 5 rows are kept as the command projected them. */
async function runDiscovery(deps: InteropDeps): Promise<InteropReport['discovery']> {
  if (!deps.discover) return { skipped: true, reason: 'no discover command in this tree (src/commands/discover.ts absent)' };
  try {
    const r = await deps.discover(deps.ctx, DISCOVER_QUERY);
    const out = r.output as Record<string, unknown>;
    if (out.ok === false) return { skipped: false, query: DISCOVER_QUERY, matched: null, payable: null, top: [], error: out };
    const rows = Array.isArray(out.resources) ? out.resources : [];
    return {
      skipped: false,
      query: DISCOVER_QUERY,
      matched: typeof out.matched === 'number' ? out.matched : null,
      payable: typeof out.payable === 'number' ? out.payable : null,
      top: rows.slice(0, 5),
    };
  } catch (err) {
    return { skipped: false, query: DISCOVER_QUERY, matched: null, payable: null, top: [], error: errorOf(err) };
  }
}

export async function runInterop(deps: InteropDeps): Promise<InteropReport> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const wallet = deps.ctx.wallet();
  const nonceBefore = new Set(deps.ctx.ledger().read().map((e) => e.nonce));
  const discovery = await runDiscovery(deps);
  log(`discover: ${discovery.skipped ? `skipped (${discovery.reason})` : `matched ${discovery.matched} payable ${discovery.payable}`}`);

  const { mandate, created } = await findOrCreateMandate(wallet, deps.ctx);
  log(`mandate ${mandate.id} ${created ? 'created' : 'reused'} · remaining ${formatUsdc(wallet.remaining(mandate.id))}`);

  const targets: TargetResult[] = [];
  for (const t of deps.targets) {
    const method = (t.method ?? 'GET').toUpperCase();
    const o = await probeOffer(deps, t);
    log(`offer ${t.name}: ${o.status ?? 'error'} in ${o.latency_ms} ms · ${o.accepts.length} accepts · timeout_ok ${o.timeout_ok}`);
    const p = await doPay(deps, t, deps.saveRoot ? `${t.name}.body` : undefined);
    log(`pay   ${t.name}: ${p.status ?? 'error'} in ${p.latency_ms} ms · ${p.amount_usd ?? '-'} · ${p.ledger_status ?? '-'} · tx ${p.tx ?? '-'}`);
    const chain = await checkChain(deps, p);
    targets.push({ name: t.name, url: t.url, method, offer: o, pay: p, chain });
  }

  // Concurrency against the busiest stranger: the same wallet, N pays at once,
  // results only (this is where a facilitator's nonce race shows).
  const ct = deps.targets.find((t) => t.name === 'omniterminal-btc') ?? deps.targets[deps.targets.length - 1];
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: deps.concurrency }, () => doPay(deps, ct, undefined, false)));
  const concurrent = { url: ct.url, n: deps.concurrency, latency_ms: ms(t0), results };
  log(`concurrent x${deps.concurrency} ${ct.name}: ${results.filter((r) => r.ledger_status === 'settled').length} settled in ${concurrent.latency_ms} ms`);

  let rec: InteropReport['reconcile'];
  try {
    rec = { counts: ((await reconcile(deps.ctx)).output as { counts: Record<string, number> }).counts };
  } catch (err) {
    rec = { error: errorOf(err) };
  }

  const pays = [...targets.map((t) => t.pay), ...results];
  // settled + unknown is what the wallet counts as spent (an unknown may have settled; reconcile decides later)
  const spent = pays.reduce((sum, p) => sum + ((p.ledger_status === 'settled' || p.ledger_status === 'unknown') && p.amount ? BigInt(p.amount) : 0n), 0n);
  const added = deps.ctx.ledger().read().filter((e) => !nonceBefore.has(e.nonce));
  const byStatus: Record<string, number> = {};
  for (const e of added) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  const sumWhere = (pred: (s: string) => boolean) => added.reduce((sum, e) => sum + (pred(e.status) ? BigInt(e.amount) : 0n), 0n);
  const notes: string[] = [];
  if ((rec.counts?.stillPending ?? 0) > 0) notes.push(`reconcile keeps ${rec.counts!.stillPending} row(s) pending: settled rows are confirmed and rejected rows released only after their ${MAX_TIMEOUT_SECONDS} s authorization validity ends; run \`agentpay reconcile\` on this home later`);
  for (const t of targets) {
    if (t.pay.error && t.pay.ledger_status === 'rejected') notes.push(`${t.name} refused after the authorization was signed (http ${t.pay.status}): the budget stays reserved until reconcile sees the nonce unused`);
    if (t.chain && t.chain.payer_is_wallet === false) notes.push(`${t.name} PAYMENT-RESPONSE names payer ${t.chain.settlement_payer}, not this wallet`);
    if (t.pay.ledger_status === 'unknown') notes.push(`${t.name} answered 2xx without a usable PAYMENT-RESPONSE: the row is unknown until reconcile`);
  }
  const now = deps.now ?? (() => Date.now());
  return {
    version: 1,
    date: new Date(now()).toISOString(),
    network: deps.config.network,
    rpc: deps.config.rpcUrl ?? null,
    payer: wallet.address,
    home: deps.config.home,
    discovery,
    mandate: {
      id: mandate.id,
      created,
      remaining_usd: formatUsdc(wallet.remaining(mandate.id)),
      valid_until: new Date(mandate.validUntil * 1000).toISOString(),
      hosts: mandate.hostAllowlist,
    },
    targets,
    concurrent,
    reconcile: rec,
    ledger: {
      rows_added: added.length,
      by_status: byStatus,
      settled_usd: formatUsdc(sumWhere((st) => st === 'settled' || st === 'unknown')),
      reserved_usd: formatUsdc(sumWhere((st) => st === 'rejected')),
    },
    totals: {
      paid: pays.filter((p) => p.ledger_status === 'settled').length,
      refused: pays.filter((p) => p.error !== undefined && p.ledger_status !== 'settled').length,
      spent_usd: formatUsdc(spent),
    },
    notes,
  };
}

/** One screen: what an operator scans before opening the JSON. */
export function formatSummary(r: InteropReport): string {
  const lines = [
    `testnet interop · ${r.date} · ${r.network} · payer ${r.payer}`,
    `discovery: ${r.discovery.skipped ? `skipped — ${r.discovery.reason}` : `${r.discovery.query} → matched ${r.discovery.matched} · payable ${r.discovery.payable}${r.discovery.error ? ' · ERROR' : ''}`}`,
    `mandate:   ${r.mandate.id} (${r.mandate.created ? 'new' : 'reused'}) · remaining ${r.mandate.remaining_usd} · hosts ${r.mandate.hosts.join(',')}`,
  ];
  for (const t of r.targets) {
    lines.push(`${t.name.padEnd(18)} offer ${String(t.offer.status ?? 'ERR').padEnd(4)} ${String(t.offer.latency_ms).padStart(5)} ms  timeout_ok=${t.offer.timeout_ok}`);
    const e = t.pay.error as { error?: string } | undefined;
    lines.push(
      `${''.padEnd(18)} pay   ${String(t.pay.status ?? 'ERR').padEnd(4)} ${String(t.pay.latency_ms).padStart(5)} ms  ${t.pay.amount_usd ?? '-'} ${t.pay.ledger_status ?? '-'} body ${t.pay.body_bytes ?? '-'} B${e ? ` error=${e.error ?? JSON.stringify(e)}` : ''}`,
    );
    if (t.pay.tx) lines.push(`${''.padEnd(18)} tx    ${t.pay.tx} from ${t.chain?.tx_from ?? '?'} payer_is_wallet=${t.chain?.payer_is_wallet}`);
  }
  const settled = r.concurrent.results.filter((p) => p.ledger_status === 'settled').length;
  lines.push(`concurrent x${r.concurrent.n}: ${settled}/${r.concurrent.n} settled in ${r.concurrent.latency_ms} ms (${r.concurrent.results.map((p) => p.ledger_status ?? (p.error as { error?: string })?.error ?? 'ERR').join(', ')})`);
  lines.push(`reconcile: ${r.reconcile.counts ? JSON.stringify(r.reconcile.counts) : `ERROR ${JSON.stringify(r.reconcile.error)}`}`);
  lines.push(`ledger:    +${r.ledger.rows_added} rows ${JSON.stringify(r.ledger.by_status)} · settled ${r.ledger.settled_usd} · reserved ${r.ledger.reserved_usd}`);
  lines.push(`totals: paid ${r.totals.paid} · refused ${r.totals.refused} · spent ${r.totals.spent_usd}`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  return lines.join('\n');
}

/** INTEROP_OUT, else docs/interop/testnet-interop-<YYYY-MM-DD>.json at the repo root. */
export function reportPath(env: NodeJS.ProcessEnv, date: Date): string {
  if (env.INTEROP_OUT) return resolve(env.INTEROP_OUT);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return join(root, 'docs', 'interop', `testnet-interop-${date.toISOString().slice(0, 10)}.json`);
}

/** The tree's `discover` command when it exists; the module path is a variable so a tree without it still typechecks. */
async function loadDiscover(): Promise<Discover | undefined> {
  const spec = new URL('../src/commands/discover.js', import.meta.url).href;
  try {
    const mod = (await import(spec)) as { discover?: (ctx: CommandContext, positional: string[], flags: Record<string, unknown>) => Promise<CliResult> };
    return mod.discover ? (ctx, query) => mod.discover!(ctx, [query], {}) : undefined;
  } catch {
    return undefined;
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config: CliConfig;
  try {
    config = guard(env);
  } catch (err) {
    process.stdout.write(`${toJson(failure(err).output)}\n`);
    return 2;
  }
  const ctx = new CommandContext(config);
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const targets = [...DEFAULT_TARGETS, ...(env.INTEROP_EXTRA_URL ? [{ name: 'extra', url: env.INTEROP_EXTRA_URL }] : [])];
  const report = await runInterop({
    ctx,
    config,
    targets,
    discover: await loadDiscover(),
    txFrom: async (hash) => (await client.getTransaction({ hash })).from,
    saveRoot: env.INTEROP_SAVE === '1' ? mkdtempSync(join(tmpdir(), 'agentpay-interop-')) : undefined,
    concurrency: Math.max(1, Number(env.INTEROP_CONCURRENCY ?? 3) || 3),
  });
  const path = reportPath(env, new Date(report.date));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${toJson(report)}\n`);
  process.stdout.write(`${formatSummary(report)}\nreport: ${path}\n`);
  return 0;
}

const invokedDirectly = (process.argv[1] ?? '').endsWith('testnet-interop.ts');
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
