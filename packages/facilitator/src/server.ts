import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { x402Facilitator } from '@x402/core/facilitator';
import type { SettleResponse, VerifyResponse } from '@x402/core/types';
import { errorMessage, isTransportError, type ChainClient, type TokenInfo } from './chain.js';
import type { ResolvedFacilitatorConfig } from './config.js';
import { isPayloadShape, isRequirementsShape, refusalReason } from './facilitator.js';

export const MAX_BODY_BYTES = 64 * 1024;

/** Facts learned at start() that /health reports. */
export interface ServerRuntime {
  tokens: TokenInfo[];
}

export interface ServerDeps {
  cfg: ResolvedFacilitatorConfig;
  chain: ChainClient;
  facilitator: x402Facilitator;
  runtime: () => ServerRuntime;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: code, message });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  sendError(res, 405, 'method_not_allowed', `use ${allow}`);
}

type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'aborted' };

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, reason: 'too_large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, reason: 'aborted' }));
  });
}

interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: unknown;
  paymentRequirements: unknown;
}

/** Parses `{ x402Version: 2, paymentPayload, paymentRequirements }`; anything else is a 400. */
async function readRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; body: FacilitatorRequest } | { ok: false }> {
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      res.setHeader('connection', 'close');
      sendError(res, 413, 'payload_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
    } else {
      sendError(res, 400, 'invalid_body', 'request aborted');
    }
    return { ok: false };
  }
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    sendError(res, 400, 'invalid_body', 'body is not JSON');
    return { ok: false };
  }
  const r = json as Partial<FacilitatorRequest> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !isPayloadShape(r.paymentPayload) || !isRequirementsShape(r.paymentRequirements)) {
    sendError(res, 400, 'invalid_body', 'body must be { x402Version: 2, paymentPayload, paymentRequirements }');
    return { ok: false };
  }
  return { ok: true, body: r as FacilitatorRequest };
}

function authorized(d: ServerDeps, req: IncomingMessage, res: ServerResponse): boolean {
  if (!d.cfg.authToken) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${d.cfg.authToken}`) return true;
  res.setHeader('www-authenticate', 'Bearer');
  sendError(res, 401, 'unauthorized', 'a valid authorization: Bearer token is required');
  return false;
}

async function handleVerify(d: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(d, req, res)) return;
  const parsed = await readRequest(req, res);
  if (!parsed.ok) return;
  const { paymentPayload, paymentRequirements } = parsed.body as { paymentPayload: any; paymentRequirements: any };
  if (parsed.body.x402Version !== 2) return sendJson(res, 200, { isValid: false, invalidReason: 'invalid_x402_version' });
  const refusal = refusalReason(d.cfg, paymentRequirements);
  if (refusal) return sendJson(res, 200, { isValid: false, invalidReason: refusal });
  let result: VerifyResponse;
  const transportErrorsBefore = d.chain.transportErrors;
  try {
    result = await d.facilitator.verify(paymentPayload, paymentRequirements);
  } catch (err) {
    const message = errorMessage(err);
    d.cfg.log(`facilitator: verify failed: ${message}`);
    if (isTransportError(err)) {
      return sendJson(res, 503, { isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: message }, { 'retry-after': '5' });
    }
    return sendJson(res, 200, { isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: message });
  }
  if (!result.isValid && d.chain.transportErrors > transportErrorsBefore) {
    // The scheme reports a failed chain read as a refusal; it was an outage.
    d.cfg.log(`facilitator: verify could not reach the chain (${result.invalidReason})`);
    return sendJson(res, 503, { ...result, invalidReason: 'unexpected_verify_error' }, { 'retry-after': '5' });
  }
  sendJson(res, 200, result);
}

async function handleSettle(d: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(d, req, res)) return;
  const parsed = await readRequest(req, res);
  if (!parsed.ok) return;
  const { paymentPayload, paymentRequirements } = parsed.body as { paymentPayload: any; paymentRequirements: any };
  const network = typeof paymentRequirements.network === 'string' ? paymentRequirements.network : d.cfg.network;
  const failure = (errorReason: string, errorMessage_?: string): SettleResponse => ({
    success: false,
    errorReason,
    ...(errorMessage_ ? { errorMessage: errorMessage_ } : {}),
    transaction: '',
    network,
  });
  if (parsed.body.x402Version !== 2) return sendJson(res, 200, failure('invalid_x402_version'));
  const refusal = refusalReason(d.cfg, paymentRequirements);
  if (refusal) return sendJson(res, 200, failure(refusal));
  let result: SettleResponse;
  const transportErrorsBefore = d.chain.transportErrors;
  try {
    result = await d.facilitator.settle(paymentPayload, paymentRequirements);
  } catch (err) {
    const message = errorMessage(err);
    d.cfg.log(`facilitator: settle failed: ${message}`);
    if (isTransportError(err)) {
      return sendJson(res, 503, failure('unexpected_settle_error', message), { 'retry-after': '5' });
    }
    return sendJson(res, 200, failure('unexpected_settle_error', message));
  }
  if (!result.success && d.chain.transportErrors > transportErrorsBefore) {
    // settlement_pending (broadcast, receipt not seen) keeps its own reason: the
    // payee retries the same authorization and the pending store returns the
    // same transaction. Everything else that failed on a dead RPC is an outage.
    if (result.errorReason !== 'settlement_pending') {
      d.cfg.log(`facilitator: settle could not reach the chain (${result.errorReason})`);
      return sendJson(res, 503, { ...result, errorReason: 'unexpected_settle_error' }, { 'retry-after': '5' });
    }
  }
  if (result.success) {
    d.cfg.log(`facilitator: settled ${result.transaction} for ${result.payer ?? '?'} (${paymentRequirements.amount} of ${paymentRequirements.asset})`);
  }
  sendJson(res, 200, result);
}

function handleSupported(d: ServerDeps, res: ServerResponse): void {
  sendJson(res, 200, d.facilitator.getSupported());
}

async function handleHealth(d: ServerDeps, res: ServerResponse): Promise<void> {
  const { cfg, chain } = d;
  const rpcOk = await chain
    .chainId()
    .then((id) => id === cfg.chainId)
    .catch(() => false);
  const ethBalance = rpcOk ? await chain.ethBalance().catch(() => undefined) : undefined;
  sendJson(res, rpcOk ? 200 : 503, {
    ok: rpcOk,
    address: chain.account.address,
    chainId: cfg.chainId,
    network: cfg.network,
    tokens: d.runtime().tokens,
    payees: cfg.payees ?? 'any',
    ethBalance: ethBalance === undefined ? null : ethBalance.toString(),
    rpcOk,
  });
}

async function route(d: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  const is = (name: string, arity: number) => seg[0] === name && seg.length === arity + 1;

  if (is('verify', 0)) return method === 'POST' ? handleVerify(d, req, res) : methodNotAllowed(res, 'POST');
  if (is('settle', 0)) return method === 'POST' ? handleSettle(d, req, res) : methodNotAllowed(res, 'POST');
  if (is('supported', 0)) return method === 'GET' ? handleSupported(d, res) : methodNotAllowed(res, 'GET');
  if (is('health', 0)) return method === 'GET' ? handleHealth(d, res) : methodNotAllowed(res, 'GET');
  return sendError(res, 404, 'not_found', `no route ${method} ${url.pathname}`);
}

/** Plain node:http server speaking the x402 facilitator API: JSON in, JSON out, 64 KB body cap. */
export function createHttpServer(d: ServerDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((err) => {
      d.cfg.log(`facilitator: ${req.method} ${req.url} failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'internal error');
      else res.end();
    });
  });
}
