import { WireError } from './errors.js';

/** Parses '$0.01' / '0.01' into USDC atomic units (6 decimals). */
export function parsePrice(price: string): bigint {
  const m = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new WireError(`unparseable price: ${JSON.stringify(price)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  const atomic = whole * 1_000_000n + frac;
  if (atomic <= 0n) throw new WireError('price must be positive');
  if (atomic > 1_000_000_000n) throw new WireError(`price above $1000 sanity cap: ${price}`);
  return atomic;
}

/** Parses either a '$1.50' style price or a bare atomic-units string ('1500000'). */
export function parseAmount(value: string): bigint {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed) && !trimmed.startsWith('$') && !trimmed.includes('.')) {
    // Ambiguous: a bare integer. Treat values with a '$' or '.' as prices; a bare
    // integer is atomic units (the wire encoding), matching FluxA's limitAmount.
    const atomic = BigInt(trimmed);
    if (atomic <= 0n) throw new WireError('amount must be positive');
    return atomic;
  }
  return parsePrice(trimmed);
}

export function formatUsdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}
