/**
 * Small generic helpers shared by the demo scripts.
 * Deliberately free of sibling-package imports so it is unit-testable
 * before the rest of the monorepo exists.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses `--only <name>` / `--only=<name>` out of argv (argv already sans node/script). */
export function parseOnly(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--only') return argv[i + 1];
    if (arg.startsWith('--only=')) return arg.slice('--only='.length) || undefined;
  }
  return undefined;
}

/** '0x12345678..abcd' style shortening for narration lines. */
export function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 10)}..${value.slice(-4)}`;
}

/** Polls `fn` until `pred(value)` holds; throws after timeoutMs. Returns the passing value. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!pred(last)) {
    if (Date.now() > deadline) throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}
