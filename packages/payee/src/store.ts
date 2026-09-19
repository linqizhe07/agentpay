import type { IdempotencyStore } from './types.js';

const SWEEP_EVERY = 256;

/**
 * In-process in-flight guard. `claim` is atomic by virtue of Node's
 * single-threaded event loop (no await between check and set). Every entry
 * carries an expiry chosen by the server, so a flood of never-settled
 * authorizations cannot grow it without bound.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>();
  private claimsSinceSweep = 0;

  claim(key: string, ttlSeconds: number, now: number): boolean {
    if (++this.claimsSinceSweep >= SWEEP_EVERY) this.sweep(now);
    const k = key.toLowerCase();
    const expiresAt = this.entries.get(k);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.entries.set(k, now + ttlSeconds);
    return true;
  }

  release(key: string): void {
    this.entries.delete(key.toLowerCase());
  }

  retain(key: string, ttlSeconds: number, now: number): void {
    this.entries.set(key.toLowerCase(), now + ttlSeconds);
  }

  has(key: string): boolean {
    return this.entries.has(key.toLowerCase());
  }

  get size(): number {
    return this.entries.size;
  }

  sweep(now: number): void {
    this.claimsSinceSweep = 0;
    for (const [k, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(k);
  }
}
