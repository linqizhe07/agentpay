import type { Hex, MandatePayload, SpReceipt } from '@agentpay/core';

/**
 * The Settlement Processor refused, answered garbage, timed out or was
 * unreachable. `reason` is the SP's error code for HTTP-level refusals
 * ('sp_not_authorized', 'insufficient_balance', ...), or 'timeout' /
 * 'unreachable' / 'malformed_response' (status 0 for transport failures).
 */
export class SpError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `settlement processor error: ${reason} (HTTP ${status})`);
    this.name = 'SpError';
  }
}

export interface SpClientConfig {
  /** Base URL of the SP, e.g. 'http://127.0.0.1:3001'. */
  url: string;
  /** Per-request timeout. Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** First line of the most specific message available, following `cause` one level. */
function describeError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; cause?: { message?: string } };
  let msg = e?.shortMessage ?? e?.message ?? String(err);
  if (e?.cause && typeof e.cause.message === 'string' && e.cause.message) msg += `: ${e.cause.message}`;
  return msg.split('\n')[0];
}

function isReceiptShape(x: unknown): x is SpReceipt {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.sp === 'string' &&
    typeof r.mandateDigest === 'string' &&
    typeof r.enqueueDeadline === 'number' &&
    typeof r.spEnqueueSig === 'string'
  );
}

function reasonOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { error?: unknown; message?: unknown };
  if (typeof b.error === 'string' && b.error) return b.error;
  if (typeof b.message === 'string' && b.message) return b.message;
  return undefined;
}

export interface SpEnqueueResult {
  receipt: SpReceipt;
  /** false when the SP already held this digest (idempotent answer with the original receipt). */
  created: boolean;
  /** Unix seconds the SP first queued the mandate, when it reports it. */
  enqueuedAt?: number;
}

/** Thin HTTP client for the Settlement Processor API (packages/sp). */
export class SpClient {
  readonly url: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: SpClientConfig, fetchImpl?: typeof fetch) {
    this.url = cfg.url.replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Wrap rather than store the global: some runtimes require fetch's `this` to be the global object.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** POST /enqueue; resolves to the SP's signed receipt (+ created flag), throws SpError otherwise. */
  async enqueue(payload: MandatePayload): Promise<SpEnqueueResult> {
    const { status, body } = await this.request('POST', '/enqueue', payload);
    const r = body as { success?: unknown; receipt?: unknown; created?: unknown; enqueuedAt?: unknown } | undefined;
    if (!r || typeof r !== 'object' || r.success !== true || !isReceiptShape(r.receipt)) {
      throw new SpError(status, 'malformed_response', body, 'settlement processor answered 2xx without a receipt');
    }
    return {
      receipt: r.receipt,
      created: r.created !== false, // absent = an SP that does not report it; assume fresh
      ...(typeof r.enqueuedAt === 'number' ? { enqueuedAt: r.enqueuedAt } : {}),
    };
  }

  /** GET /status/:digest (the SP's record projection; SpError 404 when unknown). */
  async status(digest: Hex): Promise<unknown> {
    return (await this.request('GET', `/status/${digest}`)).body;
  }

  /** GET /supported: chain, wallet, tokens, settle window. */
  async supported(): Promise<unknown> {
    return (await this.request('GET', '/supported')).body;
  }

  /** GET /health. */
  async health(): Promise<unknown> {
    return (await this.request('GET', '/health')).body;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new SpError(0, 'timeout', undefined, `settlement processor did not answer within ${this.timeoutMs}ms`);
      }
      throw new SpError(0, 'unreachable', undefined, `settlement processor unreachable: ${describeError(err)}`);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (status < 200 || status >= 300) {
      const reason = reasonOf(body) ?? `http_${status}`;
      throw new SpError(status, reason, body, `settlement processor refused: ${reason} (HTTP ${status})`);
    }
    return { status, body };
  }
}
