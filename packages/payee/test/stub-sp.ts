/**
 * Minimal Settlement Processor double on node:http (port 0). Speaks the SP API
 * the paywall relies on (POST /enqueue, GET /status/:digest, /supported,
 * /health) and signs REAL receipts with core's signSpReceipt, so the paywall's
 * receipt verification runs for real. `mode` is mutable so one server can be
 * flipped between behaviours mid-test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assertMandateShape,
  mandateDigest,
  paymentModelContext,
  signSpReceipt,
  type Address,
  type Hex,
  type MandateDomain,
  type MandatePayload,
} from '@agentpay/core';

export type StubSpMode =
  | 'ok' // signs a correct receipt: enqueueDeadline = min(deadline, now + settleWindow)
  | 'reject' // answers {success:false, error: rejectCode} with rejectStatus
  | 'down' // drops the connection without answering
  | 'bad-sig' // receipt claims the SP address but is signed by an impostor key
  | 'wrong-sp' // consistent receipt from a different SP address
  | 'late-deadline' // enqueueDeadline far beyond the settle window
  | 'slow' // answers correctly, but only after slowMs
  | 'duplicate'; // correct receipt, but created:false with an enqueuedAt two minutes in the past (a replay)

export interface StubSpOptions {
  /** The SP's private key (hardhat #3 in tests). */
  key: Hex;
  /** Receipt domain: chainId + the AEP2DebitWallet the receipts promise to settle against. */
  domain: MandateDomain;
  settleWindowSeconds: number;
  mode?: StubSpMode;
  /** For mode 'reject'. Default 'sp_not_authorized' / 403. */
  rejectCode?: string;
  rejectStatus?: number;
  /** For mode 'slow'. Default 2000. */
  slowMs?: number;
  /** Injectable clock (unix seconds). */
  now?: () => number;
}

export interface StubSp {
  url: string;
  address: Address;
  mode: StubSpMode;
  rejectCode: string;
  rejectStatus: number;
  /** Every well-formed /enqueue body received, in order. */
  calls: MandatePayload[];
  close(): Promise<void>;
}

// Hardhat public dev key #4 ("stranger"): the impostor for bad-sig / wrong-sp.
const IMPOSTOR_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startStubSp(opts: StubSpOptions): Promise<StubSp> {
  const account = privateKeyToAccount(opts.key);
  const impostor = privateKeyToAccount(IMPOSTOR_KEY);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const timers = new Set<NodeJS.Timeout>();

  const stub: StubSp = {
    url: '',
    address: account.address,
    mode: opts.mode ?? 'ok',
    rejectCode: opts.rejectCode ?? 'sp_not_authorized',
    rejectStatus: opts.rejectStatus ?? 403,
    calls: [],
    close,
  };

  function reject(res: ServerResponse, status: number, code: string, message: string, digest?: Hex): void {
    send(res, status, {
      success: false,
      error: code,
      message,
      ...(digest ? { mandateDigest: digest } : {}),
      payment_model_context: paymentModelContext(code),
    });
  }

  async function enqueue(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (stub.mode === 'down') {
      req.socket.destroy();
      return;
    }
    const text = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      reject(res, 400, 'invalid_body', 'body is not JSON');
      return;
    }
    const p = (body ?? {}) as Partial<MandatePayload>;
    try {
      assertMandateShape(p.mandate);
    } catch (err) {
      reject(res, 400, 'invalid_body', (err as Error).message);
      return;
    }
    if (typeof p.payerSig !== 'string') {
      reject(res, 400, 'invalid_body', 'payerSig missing');
      return;
    }
    const payload: MandatePayload = { mandate: p.mandate, payerSig: p.payerSig };
    stub.calls.push(payload);
    const digest = mandateDigest(opts.domain, payload.mandate);

    if (stub.mode === 'reject') {
      reject(res, stub.rejectStatus, stub.rejectCode, `stub SP rejects with ${stub.rejectCode}`, digest);
      return;
    }

    const t = now();
    let enqueueDeadline = Math.min(payload.mandate.deadline, t + opts.settleWindowSeconds);
    let signer = account;
    let claimedSp: Address = account.address;
    switch (stub.mode) {
      case 'bad-sig':
        signer = impostor; // signature will not recover to the claimed SP address
        break;
      case 'wrong-sp':
        signer = impostor;
        claimedSp = impostor.address; // internally consistent, but not the SP the offer named
        break;
      case 'late-deadline':
        enqueueDeadline = t + opts.settleWindowSeconds + 3600;
        break;
      default:
        break;
    }
    const receipt = { ...(await signSpReceipt(signer, opts.domain, digest, enqueueDeadline)), sp: claimedSp };
    const duplicate = stub.mode === 'duplicate';
    const out = { success: true, status: 'enqueued', created: !duplicate, enqueuedAt: duplicate ? t - 120 : t, receipt };
    if (stub.mode === 'slow') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        send(res, 200, out);
      }, opts.slowMs ?? 2000);
      timers.add(timer);
      return;
    }
    send(res, 200, out);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, sp: account.address, mode: stub.mode, counts: { pending: stub.calls.length } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/supported') {
      send(res, 200, {
        chainId: opts.domain.chainId,
        network: `eip155:${opts.domain.chainId}`,
        wallet: opts.domain.verifyingContract,
        sp: account.address,
        tokens: [],
        settleWindowSeconds: opts.settleWindowSeconds,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
      const digest = url.pathname.slice('/status/'.length).toLowerCase();
      const hit = stub.calls.find((c) => mandateDigest(opts.domain, c.mandate).toLowerCase() === digest);
      if (hit) send(res, 200, { mandateDigest: digest, status: 'pending', mandate: hit.mandate });
      else reject(res, 404, 'not_found', 'unknown mandate');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/enqueue') {
      await enqueue(req, res);
      return;
    }
    reject(res, 404, 'not_found', `no route ${req.method} ${url.pathname}`);
  }

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      reject(res, 500, 'internal', (err as Error).message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub SP: no ephemeral port');
  stub.url = `http://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return stub;
}
