/**
 * The host-agnostic tool table: what a host process (a chat face, an MCP
 * server, an agent runtime) registers with its model, and the handlers that
 * serve it. Nothing here knows how a host names its sessions or renders a
 * result; the host derives the Caller and the PaymentContext and passes them
 * in `meta`, the handlers answer with the CLI's JSON envelope so a model
 * reads the same `payment_model_context` hints whether it shelled out to
 * `agentpay` or called a tool.
 *
 * Amounts cross as USD strings in both directions (a model types "0.25",
 * never atomic units); the command handlers convert. Budgets are never
 * created here without the human: `wallet_budget_request` creates an
 * approved budget only because the host shows the request to its operator
 * first (`principalOnly`), and a delegation is bounded by its parent, which
 * the human approved.
 */
import { formatUsdc } from '@agentpay/core';
import { PRINCIPAL, holderSetFor, validatePaymentContext, type Caller, type IntentMandate, type PaymentContext } from '@agentpay/wallet';
import { usdToAtomicString } from './amounts.js';
import { callerLabel } from './attribution.js';
import { ConfigError } from './config.js';
import type { CommandContext } from './context.js';
import { mandateCreate, DEFAULT_DELEGATED_VALID_FOR_SECONDS, DEFAULT_VALID_FOR_SECONDS } from './commands/mandate.js';
import { offer, pay } from './commands/pay.js';
import { reconcile, report } from './commands/ledger.js';
import { failure, ok, type CliResult } from './output.js';

/** A tool's JSON schema, the subset every host understands (objects, strings, numbers, booleans, arrays, enums). */
export type JsonSchema = Record<string, unknown>;

export interface WalletTool {
  name: string;
  /** Written for the model: what it costs, when to use it, what it needs first. */
  description: string;
  parameters: JsonSchema;
  /**
   * How a host should treat the call: `fetch` sends an HTTP request (and may
   * spend), `read` only reads the wallet's files, `other` writes them
   * (budgets) or touches the chain (reconcile).
   */
  kind: 'fetch' | 'read' | 'other';
  /** Only the principal (the operator's own session) may call it; a child or bot gets a `holder_mismatch`-style refusal. */
  principalOnly: boolean;
}

const USD = { type: 'string', pattern: '^\\$?\\d+(\\.\\d{1,6})?$', description: 'US dollars as a string, e.g. "0.25" or "5"' } as const;
const HOURS = { type: 'number', minimum: 0.001, description: 'Validity in hours' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Spec §4.4: money crosses as bare USD strings ("0.001000"); formatUsdc's `$` is the CLI's human convention. */
const usd = (atomic: bigint | string): string => formatUsdc(BigInt(atomic)).replace(/^\$/, '');

/** The maximum body a wallet_pay result carries back into the model's context. */
export const MAX_BODY_BYTES = 8 * 1024;

export const WALLET_TOOLS: readonly WalletTool[] = [
  {
    name: 'wallet_offer',
    description:
      'Ask a paid HTTP resource what it costs WITHOUT paying. Returns the x402 offer (amount_usd per option, network, payee). ' +
      'Use it before wallet_pay when the price is unknown or the user asked what something costs. Free (no request body is sent). ' +
      'A budget naming the host must be held; otherwise the reply says how to get one.',
    parameters: obj({
      url: { type: 'string', format: 'uri', description: 'The resource URL' },
      method: { type: 'string', description: 'HTTP method; default GET' },
    }, ['url']),
    kind: 'fetch',
    principalOnly: false,
  },
  {
    name: 'wallet_pay',
    description:
      'Fetch a paid HTTP resource, paying the x402 price from one of YOUR budgets (a human-approved budget naming the host, ' +
      'with enough remaining, within its per-call cap). Spends real money: use it when the user wants the resource, not to browse. ' +
      'Returns the response body (truncated at 8 KB, body_truncated:true), what was charged (amount_usd) and what the budget has left (remaining_usd). ' +
      'For data you will process rather than read (anything over a few KB: bars, files, exports) pass save_to: the whole body is written ' +
      'to that file under the host\'s save directory and the result carries saved {path, bytes, sha256, content_type} plus a 1 KB preview instead of the body. ' +
      'On refusal, payment_model_context says why and what to do (e.g. wallet_budget_request); do not retry the same call blindly.',
    parameters: obj({
      url: { type: 'string', format: 'uri', description: 'The resource URL' },
      method: { type: 'string', description: 'HTTP method; default GET, or POST when a body is given' },
      body: { type: 'string', description: 'Request body (JSON text); sets content-type application/json unless a header overrides it' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers' },
      mandate_id: { type: 'string', description: 'Charge this budget instead of auto-selecting one you hold' },
      save_to: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Relative file path (e.g. "massive/AAPL/2016-01-01_2016-12-31.json") to save the response body to, inside the host\'s save directory. ' +
          'No absolute paths, no "..", never overwrites unless overwrite is true. The result has saved.sha256 (the receipt) and a preview, not the body. ' +
          'It also becomes the payment\'s label unless you set one.',
      },
      overwrite: { type: 'boolean', description: 'With save_to: replace the file if it already exists (default false)' },
    }, ['url']),
    kind: 'fetch',
    principalOnly: false,
  },
  {
    name: 'wallet_budget_request',
    description:
      'Request a new spending budget (an intent mandate) for the principal session. The HUMAN approves it in the host before it exists; ' +
      'ask for what the task needs, no more: a purpose in plain words, a total limit_usd, the hosts it may pay, and a validity ' +
      '(default 24 h). Only the principal session may call it; a child session asks its parent to delegate instead.',
    parameters: obj({
      purpose: { type: 'string', minLength: 1, maxLength: 512, description: 'What this budget is for, in plain words (shown to the human)' },
      limit_usd: USD,
      hosts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Hosts it may pay, e.g. ["api.example.com"]; "*" only if the user explicitly allows any host' },
      valid_for_hours: HOURS,
      per_call_usd: { ...USD, description: 'Cap per single payment, USD string' },
      category: { type: 'string', maxLength: 128 },
    }, ['purpose', 'limit_usd', 'hosts']),
    kind: 'other',
    principalOnly: true,
  },
  {
    name: 'wallet_budget_delegate',
    description:
      'Carve a sub-budget out of one of your budgets for your child sessions ({children:true}: every child you spawn shares it, ' +
      'siblings compete for its remaining) or for one named session ({session:"<id>"}). No human approval is needed because it ' +
      'cannot exceed the parent: limit_usd <= the parent\'s remaining, validity <= the parent\'s and <= 24 h (default 1 h), hosts ' +
      'within the parent\'s (default: the same), per_call_usd <= the parent\'s. What the children spend is spent from the parent too.',
    parameters: obj({
      parent_id: { type: 'string', description: 'The budget to delegate from (one you hold; see wallet_budgets)' },
      limit_usd: USD,
      for: {
        oneOf: [
          obj({ children: { type: 'boolean', const: true } }, ['children']),
          obj({ session: { type: 'string', minLength: 1 } }, ['session']),
        ],
        description: '{children:true} for the sessions you spawn, or {session:"<id>"} for one session',
      },
      valid_for_hours: { ...HOURS, maximum: 24 },
      hosts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Subset of the parent\'s hosts; default the parent\'s' },
      per_call_usd: { ...USD, description: 'Cap per single payment, USD string' },
      label: { type: 'string', maxLength: 256, description: 'Purpose shown beside the sub-budget; default the parent\'s purpose + " (delegated)"' },
    }, ['parent_id', 'limit_usd', 'for']),
    kind: 'other',
    principalOnly: false,
  },
  {
    name: 'wallet_budget_disable',
    description:
      'Switch off a budget you hold (or one you delegated) so nothing more is paid from it. Reversible by the human only. ' +
      'Use it when a task is over or a payee misbehaves.',
    parameters: obj({ id: { type: 'string', description: 'The budget id (im_…)' } }, ['id']),
    kind: 'other',
    principalOnly: false,
  },
  {
    name: 'wallet_budgets',
    description:
      'List the budgets YOU can spend from (limit, remaining over the whole chain, hosts, validity, holder, enabled) with the wallet ' +
      'address, network and USDC balance. Free; call it before paying when you do not know what you hold, or before delegating.',
    parameters: obj({}),
    kind: 'read',
    principalOnly: false,
  },
  {
    name: 'wallet_report',
    description:
      'Spend report over every budget: totals, by host, by resource, by channel and by session, every budget\'s counters and the policy denials. ' +
      'Free; for the operator\'s questions about where the money went.',
    parameters: obj({}),
    kind: 'read',
    principalOnly: true,
  },
  {
    name: 'wallet_reconcile',
    description:
      'Reconcile the ledger against the chain: books settlements the wallet could not confirm, releases expired unused reservations. ' +
      'Needs an RPC and takes seconds. Free; call it when the operator asks about a pending or unknown payment.',
    parameters: obj({}),
    kind: 'other',
    principalOnly: true,
  },
];

export interface ToolCallMeta {
  /** Attribution the host derived (channel, session, callId…): copied onto the ledger row. */
  context?: PaymentContext;
  /** Whose budgets the call may spend. */
  caller: Caller;
  /** The host's id for the calling session: what `for:{children:true}` delegates to (`children:<requesterSession>`). */
  requesterSession?: string;
  /**
   * The directory `wallet_pay.save_to` is relative to. The host decides it
   * per session (a channel's `vendor/` directory, say) and leaves it unset
   * for a session that may not write files: `save_to` is then a usage error
   * and no payment happens.
   */
  saveRoot?: string;
}

export type WalletToolHandler = (name: string, args: unknown, meta: ToolCallMeta) => Promise<CliResult>;

export interface WalletToolOptions {
  /** Validity of a requested root budget when the model gives none; default 24 h. */
  defaultValidForHours?: number;
}

/* ---------- argument validation: a bad argument is a usage error (code 2) before anything is sent ---------- */

type Args = Record<string, unknown>;

function usage(message: string): never {
  throw new ConfigError(message);
}

function argsOf(name: string, raw: unknown, allowed: readonly string[]): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) usage(`${name}: arguments must be an object`);
  for (const k of Object.keys(raw as Args)) if (!allowed.includes(k)) usage(`${name}: unknown argument ${JSON.stringify(k)}`);
  return raw as Args;
}

function str(a: Args, k: string, name: string, required = false): string | undefined {
  const v = a[k];
  if (v === undefined) {
    if (required) usage(`${name}: ${k} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || (required && v.length === 0)) usage(`${name}: ${k} must be a non-empty string`);
  return v as string;
}

function url(a: Args, name: string): string {
  const u = str(a, 'url', name, true)!;
  try {
    new URL(u);
  } catch {
    usage(`${name}: not a URL: ${u}`);
  }
  return u;
}

function hosts(a: Args, name: string, required: boolean): string[] | undefined {
  const v = a.hosts;
  if (v === undefined) {
    if (required) usage(`${name}: hosts is required (an array of host names)`);
    return undefined;
  }
  if (!Array.isArray(v) || v.length === 0 || v.some((h) => typeof h !== 'string' || h.trim().length === 0 || h.includes(','))) {
    usage(`${name}: hosts must be a non-empty array of host names`);
  }
  return (v as string[]).map((h) => h.trim());
}

/** Hours (a model's unit) as the command handlers' whole seconds; sub-second fractions round up so a tiny validity is never 0. */
function validForSeconds(a: Args, name: string, defaultHours: number): number {
  const v = a.valid_for_hours ?? defaultHours;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) usage(`${name}: valid_for_hours must be a positive number`);
  return Math.max(1, Math.ceil((v as number) * 3600));
}

function headersArg(a: Args, name: string): string[] | undefined {
  const v = a.headers;
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) usage(`${name}: headers must be an object of strings`);
  return Object.entries(v as Record<string, unknown>).map(([k, val]) => {
    if (typeof val !== 'string' || !k.trim()) usage(`${name}: headers must be an object of strings`);
    return `${k}=${val}`;
  });
}

/* ---------- projections (spec §4.4: snake_case, USD strings, ISO times, never the signature) ---------- */

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/** A mandate as a tool result shows it: no `signature`/`mandateHash` (a model must never see or repeat signing material). */
export function budgetView(m: IntentMandate, effectiveRemaining: bigint) {
  return {
    id: m.id,
    purpose: m.naturalLanguage,
    ...(m.holder ? { holder: m.holder } : {}),
    ...(m.parentId ? { parent_id: m.parentId } : {}),
    ...(m.category ? { category: m.category } : {}),
    hosts: [...m.hostAllowlist],
    limit_usd: usd(m.limitAmount),
    spent_usd: usd(m.spentAmount),
    pending_usd: usd(m.pendingSpentAmount),
    remaining_usd: usd(effectiveRemaining),
    ...(m.perCallMax !== undefined ? { per_call_usd: usd(m.perCallMax) } : {}),
    ...(m.maxCallsPerMinute !== undefined ? { max_calls_per_minute: m.maxCallsPerMinute } : {}),
    valid_from: iso(m.validFrom),
    valid_until: iso(m.validUntil),
    status: m.status,
    enabled: m.isEnabled,
  };
}

/** Rewrites a command envelope's `mandate` (the CLI view) as the tool projection. */
function withBudget(r: CliResult, ctx: CommandContext): CliResult {
  const out = r.output as { ok?: boolean; mandate?: IntentMandate };
  if (!out.ok || !out.mandate) return r;
  return { code: r.code, output: { ok: true, mandate: budgetView(out.mandate, ctx.wallet().effectiveRemaining(out.mandate.id)) } };
}

const BALANCE_TIMEOUT_MS = 3_000;

/**
 * The balance as `{usd}` or `{unavailable}`: a listing must never fail
 * because the RPC is down or slow, so the read is bounded and every failure
 * becomes a string the model can relay.
 */
async function balanceOf(ctx: CommandContext): Promise<{ usd: string } | { unavailable: string }> {
  if (!ctx.config.rpcUrl) return { unavailable: 'no RPC configured' };
  let timer: NodeJS.Timeout | undefined;
  try {
    const bal = await Promise.race([
      ctx.wallet().balance(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC did not answer within ${BALANCE_TIMEOUT_MS} ms`)), BALANCE_TIMEOUT_MS);
      }),
    ]);
    return { usd: usd(bal) };
  } catch (err) {
    return { unavailable: (err as Error).message?.split('\n')[0] ?? String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounds a response body for the model's context: text is cut, JSON is re-serialised and cut when too long. */
function boundBody(body: unknown): { body: unknown; body_truncated?: true } {
  if (body === undefined || body === null) return { body: '' };
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) return { body };
  return { body: Buffer.from(text, 'utf8').subarray(0, MAX_BODY_BYTES).toString('utf8'), body_truncated: true };
}

/* ---------- the handlers ---------- */

/**
 * The tool handlers over one CommandContext (one wallet). Every result is a
 * CLI envelope: `ok: true` with the tool's payload, or `ok: false` with the
 * reason code, `payment_model_context` for a policy or payee refusal, and
 * `code` 2 for a malformed call (unknown tool, bad argument, a caller that
 * may not use the tool). Nothing throws: a host relays the envelope as the
 * tool's value.
 */
export function createWalletToolHandlers(ctx: CommandContext, opts: WalletToolOptions = {}): WalletToolHandler {
  const defaultRootSeconds = opts.defaultValidForHours !== undefined ? Math.max(1, Math.ceil(opts.defaultValidForHours * 3600)) : DEFAULT_VALID_FOR_SECONDS;
  const tools = new Map(WALLET_TOOLS.map((t) => [t.name, t]));

  const handlers: Record<string, (a: Args, meta: ToolCallMeta) => Promise<CliResult>> = {
    async wallet_offer(a, meta) {
      const u = url(a, 'wallet_offer');
      const method = str(a, 'method', 'wallet_offer');
      // No body, no headers: a probe carries nothing a payee could act on.
      const r = await offer(ctx, [u], { method, caller: meta.caller, ...(meta.context ? { context: meta.context } : {}) });
      const out = r.output as { ok: boolean; status?: number; offer?: Array<Record<string, unknown>>; resource?: unknown; error?: unknown; note?: string; body?: unknown };
      if (!out.ok) return { code: r.code, output: { ...out, url: u } };
      // Not 402 (spec §4.4: `{status, paid:false, note}`): the body is bounded like wallet_pay's, a free page is still a page.
      if (out.status !== 402) return { code: r.code, output: { ...out, url: u, ...boundBody(out.body) } };
      const resource = out.resource as { url?: string; description?: string } | undefined;
      return ok({
        status: 402,
        url: u,
        offer: (out.offer ?? []).map((o) => ({
          scheme: o.scheme,
          network: o.network,
          amount_usd: typeof o.amount === 'string' && /^\d+$/.test(o.amount) ? usd(o.amount) : null,
          asset: o.asset,
          payTo: o.payTo,
          maxTimeoutSeconds: o.maxTimeoutSeconds,
        })),
        ...(resource?.url ? { resource: resource.url } : {}),
        ...(resource?.description ? { description: resource.description } : {}),
        ...(out.note ? { note: out.note } : {}),
        payment_model_context: (out as { payment_model_context?: unknown }).payment_model_context,
      });
    },

    async wallet_pay(a, meta) {
      const u = url(a, 'wallet_pay');
      const host = new URL(u).host;
      let saveTo: string | undefined;
      let r: CliResult;
      try {
        // Inside the try: a refused save (like a refused payment) names the url and host it was for.
        saveTo = str(a, 'save_to', 'wallet_pay');
        if (saveTo !== undefined && saveTo.length === 0) usage('wallet_pay: save_to must be a non-empty relative path');
        if (a.overwrite !== undefined && typeof a.overwrite !== 'boolean') usage('wallet_pay: overwrite must be a boolean');
        if (saveTo !== undefined && !meta.saveRoot) {
          usage('wallet_pay: save_to needs a save directory and the host gave this session none (ToolCallMeta.saveRoot); pay without save_to, or ask the operator for a session that may write files');
        }
        // The file name is the natural label of a purchase: the ledger row (and the host's spend table) names it unless the host set its own.
        const context = saveTo !== undefined && !meta.context?.label ? { ...meta.context, label: saveTo } : meta.context;
        r = await pay(ctx, [u], {
          method: str(a, 'method', 'wallet_pay'),
          body: str(a, 'body', 'wallet_pay'),
          header: headersArg(a, 'wallet_pay'),
          mandate: str(a, 'mandate_id', 'wallet_pay'),
          caller: meta.caller,
          ...(context ? { context } : {}),
          ...(saveTo !== undefined ? { save: saveTo, saveRoot: meta.saveRoot, overwrite: a.overwrite === true } : {}),
        });
      } catch (err) {
        const f = failure(err);
        return { code: f.code, output: { ...(f.output as object), url: u, host } };
      }
      const out = r.output as {
        status: number;
        paid: boolean;
        body?: unknown;
        saved?: unknown;
        preview?: string;
        preview_truncated?: boolean;
        payment: { transaction?: string | null; intentMandateId?: string; amount?: string; ledgerStatus?: string; resource?: string; context?: unknown; payment_model_context?: unknown } | null;
      };
      const entry = out.payment;
      const method = (str(a, 'method', 'wallet_pay') ?? (a.body !== undefined ? 'POST' : 'GET')).toUpperCase();
      const mandate = entry?.intentMandateId;
      return ok({
        status: out.status,
        paid: out.paid,
        amount_usd: entry?.amount ? usd(entry.amount) : '0.000000',
        mandate: mandate ?? null,
        remaining_usd: mandate && ctx.wallet().getMandate(mandate) ? usd(ctx.wallet().effectiveRemaining(mandate)) : null,
        ...(entry?.transaction ? { tx: entry.transaction } : {}),
        ledger_status: entry?.ledgerStatus ?? (out.paid ? 'settled' : 'unpaid'),
        url: u,
        resource: `${method} ${new URL(u).pathname}`,
        host,
        network: ctx.config.network,
        ...(entry?.context ? { context: entry.context } : {}),
        // An `unknown` outcome (2xx without a usable settlement report) keeps the CLI's hint: reconcile before paying again.
        ...(entry?.payment_model_context ? { payment_model_context: entry.payment_model_context } : {}),
        // Saved: the file's receipt and a preview, never the body (the point of save_to is to keep it out of the context).
        ...(out.saved !== undefined ? { saved: out.saved, preview: out.preview, preview_truncated: out.preview_truncated } : boundBody(out.body)),
      });
    },

    async wallet_budget_request(a) {
      const name = 'wallet_budget_request';
      const r = await mandateCreate(ctx, [], {
        purpose: str(a, 'purpose', name, true),
        limit: str(a, 'limit_usd', name, true),
        hosts: hosts(a, name, true)!.join(','),
        'valid-for': String(validForSeconds(a, name, defaultRootSeconds / 3600)),
        'per-call': str(a, 'per_call_usd', name),
        category: str(a, 'category', name),
      });
      return withBudget(r, ctx);
    },

    async wallet_budget_delegate(a, meta) {
      const name = 'wallet_budget_delegate';
      const parentId = str(a, 'parent_id', name, true)!;
      const target = a.for;
      let holder: string;
      if (typeof target === 'object' && target !== null && (target as Args).children === true) {
        if (!meta.requesterSession) usage(`${name}: for.children needs the caller's session id (the host did not identify this session)`);
        holder = `children:${meta.requesterSession}`;
      } else if (typeof target === 'object' && target !== null && typeof (target as Args).session === 'string' && ((target as Args).session as string).length > 0) {
        holder = `session:${(target as Args).session as string}`;
      } else {
        usage(`${name}: for must be {children:true} or {session:"<id>"}`);
      }
      const wallet = ctx.wallet();
      const parent = wallet.getMandate(parentId);
      if (!parent) usage(`${name}: no budget with id ${parentId}`);
      // Only what the caller holds can be delegated: a session must not carve up the principal's budgets.
      if (!holderSetFor(meta.caller).has(parent!.holder ?? '')) {
        usage(`${name}: budget ${parentId} is not held by ${callerLabel(meta.caller)}`);
      }
      const untilParent = parent!.validUntil - Math.floor(Date.now() / 1000);
      const seconds = a.valid_for_hours === undefined ? Math.max(1, Math.min(DEFAULT_DELEGATED_VALID_FOR_SECONDS, untilParent)) : validForSeconds(a, name, 0);
      const limit = str(a, 'limit_usd', name, true)!;
      const perCall = str(a, 'per_call_usd', name);
      const label = str(a, 'label', name);
      const hostList = hosts(a, name, false) ?? [...parent!.hostAllowlist];
      const m = await wallet.delegateIntentMandate(
        parentId,
        {
          naturalLanguage: label ?? `${parent!.naturalLanguage} (delegated)`,
          limitAmount: usdToAtomicString(limit, `${name}: limit_usd`),
          validForSeconds: seconds,
          hostAllowlist: hostList,
          ...(perCall !== undefined ? { perCallMax: usdToAtomicString(perCall, `${name}: per_call_usd`) } : {}),
        },
        holder!,
      );
      return ok({ mandate: budgetView(m, wallet.effectiveRemaining(m.id)) });
    },

    async wallet_budget_disable(a, meta) {
      const id = str(a, 'id', 'wallet_budget_disable', true)!;
      const wallet = ctx.wallet();
      const m = wallet.getMandate(id);
      if (!m) usage(`wallet_budget_disable: no budget with id ${id}`);
      // Held by the caller, or delegated by it (the parent is in the caller's set): a stranger's budget is not its to switch off.
      const set = holderSetFor(meta.caller);
      const parent = m!.parentId ? wallet.getMandate(m!.parentId) : undefined;
      if (!set.has(m!.holder ?? '') && !(parent && set.has(parent.holder ?? ''))) {
        usage(`wallet_budget_disable: budget ${id} is not held by ${callerLabel(meta.caller)}`);
      }
      wallet.setEnabled(id, false);
      return ok({ id, enabled: false });
    },

    async wallet_budgets(_a, meta) {
      const wallet = ctx.wallet();
      const set = holderSetFor(meta.caller);
      const mandates = wallet
        .listMandates()
        .filter((m) => set.has(m.holder ?? ''))
        .map((m) => budgetView(m, wallet.effectiveRemaining(m.id)));
      return ok({
        address: wallet.address,
        network: ctx.config.network,
        balance: await balanceOf(ctx),
        caller: { kind: meta.caller.kind, ...(meta.caller.id ? { id: meta.caller.id } : {}) },
        mandates,
        alerts: [],
      });
    },

    async wallet_report() {
      return report(ctx);
    },

    async wallet_reconcile() {
      const r = await reconcile(ctx);
      const out = r.output as { ok: boolean; counts?: { settled: number; expiredUnused: number; stillPending: number; verified: number } };
      if (!out.ok || !out.counts) return r;
      const c = out.counts;
      return ok({ settled: c.settled, expired_unused: c.expiredUnused, still_pending: c.stillPending, verified: c.verified });
    },
  };

  return async (name, args, meta) => {
    try {
      const tool = tools.get(name);
      if (!tool) usage(`unknown tool ${JSON.stringify(name)}; the wallet tools are ${WALLET_TOOLS.map((t) => t.name).join(', ')}`);
      const caller = meta?.caller ?? PRINCIPAL;
      holderSetFor(caller); // a malformed caller is the host's bug: refused as a usage error, like the CLI's --caller
      if (meta?.context !== undefined) validatePaymentContext(meta.context);
      if (tool!.principalOnly && caller.kind !== 'principal') {
        usage(`${name}: only the principal session may call it (caller is ${callerLabel(caller)}); a child asks its parent to delegate a budget`);
      }
      const a = argsOf(name, args, Object.keys((tool!.parameters as { properties: Record<string, unknown> }).properties));
      return await handlers[name](a, { ...meta, caller });
    } catch (err) {
      return failure(err);
    }
  };
}
