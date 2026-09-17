import type { Hex } from '@agentpay/core';
import type { IdempotencyStore } from './types.js';

/**
 * In-process idempotency store. `claim` is atomic by virtue of Node's
 * single-threaded event loop (no await between check and set).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly claims = new Set<string>();

  claim(digest: Hex): boolean {
    const key = digest.toLowerCase();
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }

  release(digest: Hex): void {
    this.claims.delete(digest.toLowerCase());
  }

  has(digest: Hex): boolean {
    return this.claims.has(digest.toLowerCase());
  }

  get size(): number {
    return this.claims.size;
  }
}
