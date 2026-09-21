/** Runs `fn` after every earlier call on the same lock has settled (fulfilled or rejected). */
export type SendLock = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A copy of @agentpay/facilitator's createSendLock (the payee must not depend
 * on the facilitator package). Serialises the calls it wraps: each one starts
 * after the previous one finished, whichever way it finished.
 */
export function createSendLock(): SendLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

// One queue per facilitator URL, shared by every paywall in the process.
// Why per URL rather than per paywall: a hosted facilitator (x402.org) signs
// every settlement from one account, and its nonce manager loses the race
// when two of our /settle calls arrive together (5 concurrent → 2 settled in
// the 2026-09 Base Sepolia run). Two paywalls pointed at the same facilitator
// would still race each other, so the lock lives here, keyed by the URL.
const locks = new Map<string, SendLock>();

/** The process-wide settle lock for a facilitator base URL (trailing slashes ignored). */
export function settleLockFor(url: string): SendLock {
  const key = url.replace(/\/+$/, '');
  let lock = locks.get(key);
  if (!lock) {
    lock = createSendLock();
    locks.set(key, lock);
  }
  return lock;
}
