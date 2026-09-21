/**
 * Host allowlist matching for intent mandates.
 *
 * A pattern is one of:
 *   - an exact host            'api.example.com'
 *   - an exact host with port  'api.example.com:8080'
 *   - a wildcard subdomain     '*.example.com' (any depth, never the apex itself)
 *   - '*'                      any host
 *
 * Matching is case-insensitive. Because a pattern may or may not carry a port,
 * callers compare each pattern against BOTH `url.hostname` and `url.host`
 * (see `urlHostCandidates`).
 */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!p || !h) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // '.example.com' or '.example.com:8080'
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return p === h;
}

/** 'host:port' -> 'host'; '[::1]:8080' -> '[::1]'; already-bare hosts pass through. */
export function hostnameOf(host: string): string {
  const m = /^(\[[^\]]*\]|[^:]+)(?::\d+)?$/.exec(host.trim());
  return m ? m[1] : host.trim();
}

/** The strings a URL's host may be matched under: hostname first, then host:port when different. */
export function urlHostCandidates(u: URL): string[] {
  return u.host !== u.hostname ? [u.hostname, u.host] : [u.hostname];
}

/** Same as urlHostCandidates but for a bare 'host' or 'host:port' string. */
export function hostCandidates(host: string): string[] {
  const bare = hostnameOf(host);
  return bare !== host.trim() ? [bare, host.trim()] : [bare];
}

/** True when any pattern in the allowlist matches any of the candidate host strings. */
export function hostAllowed(allowlist: readonly string[], candidates: readonly string[]): boolean {
  return allowlist.some((pattern) => candidates.some((c) => matchHost(pattern, c)));
}

/**
 * Whether every host `childPattern` admits is one `parentPatterns` admits (a
 * delegated budget may narrow its parent's hosts, never widen them). True when
 * a parent is '*'; the child equals a parent pattern; the child is a concrete
 * host (no '*') some parent pattern matches; the child is 'h:port' whose 'h'
 * some parent matches (at pay time a URL is matched under both hostname and
 * host:port, so a parent naming 'h' already admits every port of it); or the
 * child is '*.sub.suffix' under a parent '*.suffix' (every match of the child
 * ends with '.suffix'). Everything else is refused, including the strict
 * subsets this rule cannot see ('*.example.com:8080' under '*.example.com'):
 * the delegator can name the parent's own pattern instead.
 */
export function hostPatternWithin(parentPatterns: readonly string[], childPattern: string): boolean {
  const child = childPattern.trim().toLowerCase();
  if (!child) return false;
  const parents = parentPatterns.map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
  if (parents.includes('*')) return true;
  if (parents.includes(child)) return true;
  if (child.includes('*')) {
    // '*.b.example.com' under '*.example.com': every match ends with '.example.com'.
    return child.startsWith('*.') && parents.some((p) => p.startsWith('*.') && matchHost(p, child.slice(2)));
  }
  if (hostAllowed(parents, [child])) return true;
  const bare = hostnameOf(child);
  return bare !== child && hostAllowed(parents, [bare]);
}
