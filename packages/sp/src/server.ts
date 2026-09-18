import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getAddress, isAddress } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  mandateDigest,
  paymentModelContext,
  recoverMandateSigner,
  type Address,
  type Hex,
  type MandateDomain,
  type SpReceipt,
} from '@agentpay/core';
import { authorizedAt, errorMessage, type ChainClient, type SpAuthorization, type TokenInfo } from './chain.js';
import type { ResolvedSPConfig } from './config.js';
import type { Queue } from './queue.js';
import { enqueueDeadlineFor, issueReceipt } from './receipt.js';
import type { JsonlStore, QueueRecord } from './store.js';
import { checkTerms, parseEnqueueBody, type Failure } from './validate.js';
import type { Worker } from './worker.js';

export const MAX_BODY_BYTES = 64 * 1024;

/** Facts learned at start() that the read-only routes report. */
export interface ServerRuntime {
  tokens: TokenInfo[];
  withdrawDelay: number;
}

export interface ServerDeps {
  cfg: ResolvedSPConfig;
  account: PrivateKeyAccount;
  chain: ChainClient;
  store: JsonlStore;
  queue: Queue;
  worker: Worker;
  runtime: () => ServerRuntime;
}

const DIGEST_RE = /^0x[0-9a-fA-F]{64}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: { mandateDigest?: Hex; detail?: Record<string, unknown> } = {},
): void {
  sendJson(res, status, {
    success: false,
    error: code,
    message,
    ...(extra.mandateDigest ? { mandateDigest: extra.mandateDigest } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    payment_model_context: paymentModelContext(code, extra.detail),
  });
}

function sendFailure(res: ServerResponse, f: Failure, mandateDigest?: Hex): void {
  sendError(res, f.status, f.code, f.message, { mandateDigest, detail: f.detail });
}

/**
 * `created` is false when the digest was already queued: the payee uses it (with
 * `enqueuedAt`) to tell a retry of its own from a replay after it lost its
 * idempotency state.
 */
function sendReceipt(res: ServerResponse, rec: QueueRecord, created: boolean): void {
  sendJson(res, 200, { success: true, status: 'enqueued', created, enqueuedAt: rec.enqueuedAt, receipt: rec.receipt });
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

function statusView(rec: QueueRecord) {
  return {
    mandateDigest: rec.mandateDigest,
    status: rec.status,
    ...(rec.errorCode ? { errorCode: rec.errorCode } : {}),
    ...(rec.txHash ? { txHash: rec.txHash } : {}),
    enqueuedAt: rec.enqueuedAt,
    updatedAt: rec.updatedAt,
    receipt: rec.receipt,
  };
}

async function handleEnqueue(d: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { cfg, queue, chain, account, worker } = d;
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    res.setHeader('connection', 'close');
    if (body.reason === 'too_large') return sendError(res, 413, 'payload_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
    return sendError(res, 400, 'invalid_body', 'request body could not be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch (err) {
    return sendError(res, 400, 'invalid_body', `body is not JSON: ${(err as Error).message}`);
  }

  // (1) shape
  const parsed = parseEnqueueBody(json);
  if (!parsed.ok) return sendFailure(res, parsed.failure);
  const { mandate, payerSig } = parsed.value;

  // (2)-(3) chain / token / params / deadline policy
  const now = cfg.clock();
  const terms = checkTerms(parsed.value, {
    chainId: cfg.chainId,
    tokens: cfg.tokens,
    now,
    minDeadlineMarginSeconds: cfg.minDeadlineMarginSeconds,
    maxDeadlineHorizonSeconds: cfg.maxDeadlineHorizonSeconds,
  });
  if (terms) return sendFailure(res, terms);

  const domain: MandateDomain = { chainId: cfg.chainId, verifyingContract: cfg.wallet };
  let digest: Hex;
  try {
    digest = mandateDigest(domain, mandate);
  } catch (err) {
    return sendError(res, 400, 'invalid_body', `mandate cannot be hashed: ${errorMessage(err)}`);
  }

  // (4) signature
  let signer: Address;
  try {
    signer = await recoverMandateSigner(domain, mandate, payerSig);
  } catch (err) {
    return sendError(res, 400, 'invalid_signature', `payerSig does not recover: ${errorMessage(err)}`, { mandateDigest: digest });
  }
  if (signer.toLowerCase() !== mandate.owner.toLowerCase()) {
    return sendError(res, 400, 'invalid_signature', `payerSig recovers to ${signer}, not mandate.owner ${mandate.owner}`, {
      mandateDigest: digest,
    });
  }

  // (5)-(6) local state, cheap, before any RPC
  const pre = queue.precheck(digest, mandate.owner, mandate.nonce);
  if (pre.kind === 'existing') return sendReceipt(res, pre.rec, false);
  if (pre.kind === 'terminal') {
    const previous = pre.rec.errorCode ?? pre.rec.status;
    return sendError(res, 409, 'mandate_terminal', `mandate already ${pre.rec.status} (${previous})`, {
      mandateDigest: digest,
      detail: { previous, status: pre.rec.status },
    });
  }
  if (pre.kind === 'nonce_conflict') {
    return sendError(res, 409, 'nonce_used', `nonce ${mandate.nonce} is already bound to mandate ${pre.digest}`, {
      mandateDigest: digest,
      detail: { nonce: mandate.nonce, boundTo: pre.digest },
    });
  }

  // (7) chain state, all read at one block that is not behind our last settlement
  // (a lagging replica would report balances a settlement already consumed).
  let authorization: SpAuthorization;
  let used: boolean;
  let debitable: bigint;
  try {
    const block = await chain.blockNumber();
    const floor = worker.lastSettledBlock;
    if (floor !== undefined && block < floor) {
      return sendError(res, 503, 'rpc_error', `chain view is stale: block ${block} < last settlement block ${floor}`, {
        mandateDigest: digest,
      });
    }
    const at = BigInt(block);
    [authorization, used, debitable] = await Promise.all([
      chain.authorizationOf(mandate.owner, at),
      chain.nonceUsed(mandate.owner, mandate.nonce, at),
      chain.debitable(mandate.owner, mandate.token, at),
    ]);
  } catch (err) {
    return sendError(res, 503, 'rpc_error', `chain read failed: ${errorMessage(err)}`, { mandateDigest: digest });
  }
  if (!authorizedAt(authorization, now)) {
    return sendError(res, 403, 'sp_not_authorized', `${mandate.owner} has not authorized settlement processor ${account.address}`, {
      mandateDigest: digest,
      detail: { sp: account.address, owner: mandate.owner },
    });
  }
  // A receipt promises settlement by enqueueDeadline (inclusive); the contract
  // stops honouring this SP at revokeAt, so a pending revocation must land later.
  const enqueueDeadline = enqueueDeadlineFor(mandate.deadline, now, cfg.settleWindowSeconds);
  if (authorization.revokeAt !== 0 && authorization.revokeAt <= enqueueDeadline) {
    return sendError(
      res,
      403,
      'sp_revocation_pending',
      `${mandate.owner} is revoking settlement processor ${account.address} at ${authorization.revokeAt}, before the settlement deadline ${enqueueDeadline}`,
      {
        mandateDigest: digest,
        detail: { sp: account.address, owner: mandate.owner, revokeAt: authorization.revokeAt, enqueueDeadline },
      },
    );
  }
  if (used) {
    return sendError(res, 409, 'nonce_used', `nonce ${mandate.nonce} is already used on-chain for ${mandate.owner}`, {
      mandateDigest: digest,
      detail: { nonce: mandate.nonce },
    });
  }

  // The receipt is pure local computation, so sign it before the admission
  // block: nothing may be awaited between the funds check and the insert.
  const receipt = await issueReceipt(account, domain, digest, enqueueDeadline);

  // (8) synchronous admission (re-checks 5/6 and the reservation arithmetic)
  const at = cfg.clock();
  const rec: QueueRecord = {
    mandateDigest: digest,
    chainId: cfg.chainId,
    wallet: cfg.wallet,
    mandate,
    payerSig,
    receipt,
    status: 'pending',
    attempts: 0,
    enqueuedAt: at,
    updatedAt: at,
  };
  const claim = queue.claim(rec, debitable);
  if (!claim.ok) {
    if (claim.code === 'mandate_terminal') {
      const previous = claim.existing.errorCode ?? claim.existing.status;
      return sendError(res, 409, 'mandate_terminal', `mandate already ${claim.existing.status} (${previous})`, {
        mandateDigest: digest,
        detail: { previous, status: claim.existing.status },
      });
    }
    if (claim.code === 'nonce_used') {
      return sendError(res, 409, 'nonce_used', `nonce ${mandate.nonce} is already bound to mandate ${claim.digest}`, {
        mandateDigest: digest,
        detail: { nonce: mandate.nonce, boundTo: claim.digest },
      });
    }
    return sendError(
      res,
      402,
      'insufficient_balance',
      `debitable balance ${claim.debitable} < amount ${claim.amount} + reserved ${claim.reserved}`,
      {
        mandateDigest: digest,
        detail: { debitable: claim.debitable.toString(), amount: claim.amount.toString(), reserved: claim.reserved.toString() },
      },
    );
  }

  // (9)
  sendReceipt(res, claim.rec, claim.created);
  if (claim.created && d.store.pending >= cfg.batchMax) worker.kick();
}

function handleStatus(d: ServerDeps, digest: string, res: ServerResponse): void {
  if (!DIGEST_RE.test(digest)) return sendError(res, 404, 'not_found', 'no such mandate');
  const rec = d.store.get(digest);
  if (!rec) return sendError(res, 404, 'not_found', 'no such mandate');
  sendJson(res, 200, statusView(rec));
}

async function handleQueue(d: ServerDeps, ownerRaw: string, url: URL, res: ServerResponse): Promise<void> {
  const { cfg, chain, queue } = d;
  if (!isAddress(ownerRaw, { strict: false })) return sendError(res, 400, 'bad_params', 'owner is not an address');
  const owner = getAddress(ownerRaw);
  const tokenRaw = url.searchParams.get('token') ?? cfg.tokens[0];
  if (!isAddress(tokenRaw, { strict: false })) return sendError(res, 400, 'bad_params', 'token is not an address');
  const token = getAddress(tokenRaw);
  if (!cfg.tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
    return sendError(res, 400, 'unsupported_token', `token ${token} is not settled by this processor`, {
      detail: { token, supported: cfg.tokens },
    });
  }
  let balance: bigint;
  let debitable: bigint;
  try {
    [balance, debitable] = await Promise.all([chain.balance(owner, token), chain.debitable(owner, token)]);
  } catch (err) {
    return sendError(res, 503, 'rpc_error', `chain read failed: ${errorMessage(err)}`);
  }
  const reserved = queue.reserved(owner, token);
  const available = debitable > reserved ? debitable - reserved : 0n;
  sendJson(res, 200, {
    owner,
    token,
    balance: balance.toString(),
    queueBalance: reserved.toString(),
    available: available.toString(),
    pending: queue.unsettled(owner, token),
  });
}

function handleSupported(d: ServerDeps, res: ServerResponse): void {
  const { cfg, account } = d;
  const rt = d.runtime();
  sendJson(res, 200, {
    chainId: cfg.chainId,
    network: `eip155:${cfg.chainId}`,
    wallet: cfg.wallet,
    sp: account.address,
    tokens: rt.tokens,
    settleWindowSeconds: cfg.settleWindowSeconds,
    withdrawDelaySeconds: rt.withdrawDelay,
    minDeadlineMarginSeconds: cfg.minDeadlineMarginSeconds,
    maxDeadlineHorizonSeconds: cfg.maxDeadlineHorizonSeconds,
    batchMax: cfg.batchMax,
  });
}

async function handleHealth(d: ServerDeps, res: ServerResponse): Promise<void> {
  const { cfg, account, chain, store, worker } = d;
  const rpcOk = await chain
    .chainId()
    .then((id) => id === cfg.chainId)
    .catch(() => false);
  sendJson(res, rpcOk ? 200 : 503, {
    ok: rpcOk,
    sp: account.address,
    chainId: cfg.chainId,
    wallet: cfg.wallet,
    counts: store.counts(),
    lastBatchAt: worker.lastBatchAt ?? null,
    rpcOk,
  });
}

async function route(d: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  const is = (name: string, arity: number) => seg[0] === name && seg.length === arity + 1;

  if (is('enqueue', 0)) return method === 'POST' ? handleEnqueue(d, req, res) : methodNotAllowed(res, 'POST');
  if (is('status', 1)) return method === 'GET' ? handleStatus(d, seg[1], res) : methodNotAllowed(res, 'GET');
  if (is('queue', 1)) return method === 'GET' ? handleQueue(d, seg[1], url, res) : methodNotAllowed(res, 'GET');
  if (is('supported', 0)) return method === 'GET' ? handleSupported(d, res) : methodNotAllowed(res, 'GET');
  if (is('health', 0)) return method === 'GET' ? handleHealth(d, res) : methodNotAllowed(res, 'GET');
  return sendError(res, 404, 'not_found', `no route ${method} ${url.pathname}`);
}

/** Plain node:http server: JSON in, JSON out, 64 KB body cap. */
export function createHttpServer(d: ServerDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((err) => {
      d.cfg.log(`sp: ${req.method} ${req.url} failed: ${errorMessage(err)}`);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'internal error');
      else res.end();
    });
  });
}
