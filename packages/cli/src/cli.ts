/**
 * agentpay — agent-facing CLI for the budgeted x402 wallet.
 *
 * Every command writes exactly one JSON document to stdout. Exit codes:
 *   0 success · 1 business error (policy denial, payee rejection, revert)
 *   2 usage / configuration error
 */
import { parseArgs } from 'node:util';
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
  mandate-list                     all mandates with remaining budget
  mandate-status <id>              one mandate + its payments

payments
  offer <url> [--method m --body b --header k=v]   print the 402 offer, pay nothing
  pay <url> [--method m --body b --header k=v --mandate id --prepay]
  ledger [--status s] | reconcile | report

setup
  init [--from-deployment localhost|base-sepolia|path.json] [--key 0x.. --rpc url --token 0x.. --network eip155:n]

global options: --key --rpc --token --network --home --deployment
config precedence: flags > AGENTPAY_* env > $AGENTPAY_HOME/config.json > packages/contracts/deployments/<name>.json`;

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
  method: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  mandate: { type: 'string' },
  prepay: { type: 'boolean' },
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
  'mandate-list': mandate.mandateList,
  'mandate-status': mandate.mandateStatus,
  offer: payCmd.offer,
  pay: payCmd.pay,
  ledger: ledgerCmd.ledger,
  reconcile: ledgerCmd.reconcile,
  report: ledgerCmd.report,
};

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
    const ctx = new CommandContext(resolveConfig(flags as CliFlags, env), fetchImpl);
    return await handler(ctx, positional, flags);
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
