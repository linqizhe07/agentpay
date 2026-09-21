/**
 * agentpay — agent-facing CLI for the budgeted x402 wallet.
 *
 * Every command writes exactly one JSON document to stdout. Exit codes:
 *   0 success · 1 business error (policy denial, payee rejection, revert)
 *   2 usage / configuration error
 */
import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { LOCK_FILE, lockedBy } from '@agentpay/wallet';
import { CALLER_GRAMMAR, contextPairsFromEnv } from './attribution.js';
import { resolveConfig, ConfigError, type CliFlags } from './config.js';
import { CommandContext } from './context.js';
import { failure, toJson, type CliResult } from './output.js';
import * as chain from './commands/chain.js';
import * as mandate from './commands/mandate.js';
import * as payCmd from './commands/pay.js';
import * as ledgerCmd from './commands/ledger.js';
import { init } from './commands/init.js';

export const USAGE = `usage: agentpay <command> [options]

wallet                             (amounts are US dollars: 5, 0.25, $0.001)
  address                          the payer address to send USDC to (no ETH needed)
  balance                          USDC balance of the payer address

intent mandates (budgets)
  mandate-request --purpose "…" --limit <usd> --hosts a.com[,b.com] [--valid-for s] [--category c] [--per-call usd] [--rate n]
                                   (agent) create a DRAFT for the user to approve
  mandate-create  …same flags… [--draft]
                                   (human) create and approve in one step
  mandate-approve <id>             (human) sign a draft
  mandate-enable <id> | mandate-disable <id>
  mandate-delegate --parent <id> --holder <holder> --limit <usd> [--valid-for s --hosts a,b --per-call usd --category c --purpose "…"]
                                   a signed sub-budget within the parent's terms (limit <= its remaining, validity <= its
                                   and <= 24h, hosts within its); holder = session:<id> | children:<sessionId> | bot:<id>
  mandate-list                     all mandates (parentId/holder for delegated ones) with their EFFECTIVE remaining budget
  mandate-status <id>              one mandate + its payments

payments
  offer <url> [--method m --body b --header k=v]   print the 402 offer, pay nothing
  pay <url> [--method m --body b --header k=v --mandate id --prepay] [--save rel/path [--overwrite]]
                                   --save writes a 2xx body to that path under the current directory (no absolute paths, no ..,
                                   existing files kept unless --overwrite) and prints saved {path, bytes, sha256} + a 1 KB preview, not the body
  ledger [--status s] | reconcile | report
  offer/pay attribution:  --context k=v (repeatable; keys channel channelName session parentSession origin callId label)
                          AGENTPAY_CONTEXT=k=v,k=v sets defaults a flag overrides
                          --caller ${CALLER_GRAMMAR}  (default principal: budgets without a holder)

setup
  init [--from-deployment localhost|base-sepolia|path.json] [--key 0x.. --rpc url --token 0x.. --network eip155:n]

global options: --key --rpc --token --network --home --deployment
config precedence: flags > AGENTPAY_* env > $AGENTPAY_HOME/config.json > packages/contracts/deployments/<name>.json
a home whose ${LOCK_FILE} names a live process (a running wallet) refuses pay, mandate-* and reconcile; the read-only commands still work`;

const OPTIONS = {
  key: { type: 'string' },
  rpc: { type: 'string' },
  token: { type: 'string' },
  network: { type: 'string' },
  home: { type: 'string' },
  deployment: { type: 'string' },
  'from-deployment': { type: 'string' },
  purpose: { type: 'string' },
  limit: { type: 'string' },
  hosts: { type: 'string' },
  'valid-for': { type: 'string' },
  category: { type: 'string' },
  'per-call': { type: 'string' },
  rate: { type: 'string' },
  draft: { type: 'boolean' },
  parent: { type: 'string' },
  holder: { type: 'string' },
  context: { type: 'string', multiple: true },
  caller: { type: 'string' },
  method: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  mandate: { type: 'string' },
  prepay: { type: 'boolean' },
  save: { type: 'string' },
  overwrite: { type: 'boolean' },
  status: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Flags = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K] extends { type: 'boolean' } ? boolean : string };

type Handler = (ctx: CommandContext, positional: string[], flags: Flags) => Promise<CliResult>;

const COMMANDS: Record<string, Handler> = {
  address: chain.address,
  balance: chain.balance,
  'mandate-request': mandate.mandateRequest,
  'mandate-create': mandate.mandateCreate,
  'mandate-approve': mandate.mandateApprove,
  'mandate-enable': mandate.mandateEnable,
  'mandate-disable': mandate.mandateDisable,
  'mandate-delegate': mandate.mandateDelegate,
  'mandate-list': mandate.mandateList,
  'mandate-status': mandate.mandateStatus,
  offer: payCmd.offer,
  pay: payCmd.pay,
  ledger: ledgerCmd.ledger,
  reconcile: ledgerCmd.reconcile,
  report: ledgerCmd.report,
};

/**
 * Commands that write mandates.json or the ledger. A long-lived wallet process
 * (lock: true) loads the store once and rewrites it from memory, so a CLI
 * write beside it would be silently dropped; these refuse a locked home.
 */
const MUTATING = new Set(['pay', 'mandate-request', 'mandate-create', 'mandate-approve', 'mandate-enable', 'mandate-disable', 'mandate-delegate', 'reconcile']);

/** Runs one CLI invocation; never throws, never touches process.exit (tests call this). */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CliResult> {
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }) as never;
  } catch (err) {
    return { code: 2, output: { ok: false, error: 'usage', message: (err as Error).message, usage: USAGE } };
  }
  const { values: flags, positionals } = parsed;
  const [command, ...positional] = positionals;

  if (!command || flags.help) {
    return { code: command ? 0 : 2, output: { ok: !!command, usage: USAGE } };
  }
  try {
    if (command === 'init') return await init(flags as CliFlags & { 'from-deployment'?: string }, env);
    const handler = COMMANDS[command];
    if (!handler) throw new ConfigError(`unknown command: ${command}\n${USAGE}`);
    const config = resolveConfig(flags as CliFlags, env);
    if (MUTATING.has(command)) {
      const dir = dirname(config.mandatesPath);
      const pid = lockedBy(dir);
      if (pid !== undefined) {
        return {
          code: 2,
          output: {
            ok: false,
            error: 'locked',
            pid,
            home: dir,
            message: `wallet home ${dir} is locked by pid ${pid} (${LOCK_FILE}): a running wallet process owns it; stop it or use --home elsewhere. mandate-list, mandate-status, report, ledger, address, balance and offer still read it`,
          },
        };
      }
    }
    const ctx = new CommandContext(config, fetchImpl);
    // env first: a --context flag overrides the same key
    const withEnv = command === 'pay' || command === 'offer' ? { ...flags, context: [...contextPairsFromEnv(env), ...(flags.context ?? [])] } : flags;
    // --save is relative to where the operator ran the command; a host process passes its own root through PayFlags instead.
    const withRoot = command === 'pay' ? { ...withEnv, saveRoot: process.cwd() } : withEnv;
    return await handler(ctx, positional, withRoot);
  } catch (err) {
    return failure(err);
  }
}

export async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${toJson(result.output)}\n`);
  process.exitCode = result.code;
}

// Only auto-run when executed directly (tsx src/cli.ts / bin), not when imported by tests.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('/cli.ts') || entry.endsWith('/cli.js') || entry.endsWith('agentpay.mjs') || entry.endsWith('/agentpay');
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main();
