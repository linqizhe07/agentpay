/**
 * Minimal in-process AEP2 payee for wallet tests, built from core helpers only
 * (deliberately decoupled from @agentpay/payee). It emits real 402 offers,
 * validates the mandate the way the payee middleware does (payee / token /
 * amount / deadline / ref / signature), answers replays with 409, and returns a
 * real SP receipt signed with the given SP key — or a deliberately broken one.
 * It also serves GET /status/:digest so `extra.sp` can point at itself.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HEADER,
  assertMandateShape,
  chainIdFromNetwork,
  encodeHeader,
  mandateDigest,
  paymentModelContext,
  readMandatePayment,
  recoverMandateSigner,
  resourceRef,
  signSpReceipt,
  type Address,
  type Hex,
  type MandateDomain,
  type MandatePayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type SettlementInfo,
  type SpReceipt,
} from '@agentpay/core';

/** Hardhat's PUBLIC dev-mnemonic keys — never real funds. */
export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  payee: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  sp: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  stranger: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const satisfies Record<string, Hex>;

export interface StubPayeeMode {
  /** How the SP receipt on a successful delivery is produced. Default 'ok'. */
  receipt?: 'ok' | 'missing' | 'bad-sig' | 'wrong-sp' | 'late-deadline';
  /** After a VALID mandate, answer with this status/body instead of serving. */
  reject?: { status: number; body: unknown };
  /** Only understand the legacy X-Payment-Mandate header (x402 envelopes get a fresh 402). */
  legacyOnly?: boolean;
  /** Also inject FluxA-style `payment: {status, spReceipt}` into the JSON body. */
  bodyPayment?: boolean;
  /** Answer every valid mandate with 409 replay (as if it had been presented before). */
  replay409?: boolean;
  /** When set, GET /status/:digest answers 200 {status}; otherwise 404. */
  spStatus?: string;
}

export interface StubPayeeOptions {
  payeeKey: Hex;
  spKey: Hex;
  wallet: Address;
  token: Address;
  network: string;
  /** Atomic units, decimal string. */
  price: string;
  settleWindowSeconds: number;
  mode?: StubPayeeMode;
  /** 'METHOD /path'; default 'GET /predict'. */
  resource?: string;
  quoteId?: string;
  maxTimeoutSeconds?: number;
  /** Payee clock (unix seconds). */
  now?: () => number;
}

export interface StubPayee {
  url: string;
  /** Payee (payTo) address. */
  address: Address;
  spAddress: Address;
  close(): Promise<void>;
  /** Successful paid deliveries. */
  readonly served: number;
  /** Every request seen, including free/status ones. */
  readonly requests: number;
  /** 402 offers emitted. */
  readonly offersSent: number;
  /** Valid mandates received (also those later refused by `reject` / 409). */
  mandates: MandatePayload[];
  offer(): PaymentRequirements;
}

function tamper(sig: Hex): Hex {
  const last = sig.slice(-1);
  return (sig.slice(0, -1) + (last === '0' ? '1' : '0')) as Hex;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startStubPayee(opts: StubPayeeOptions): Promise<StubPayee> {
  const payee = privateKeyToAccount(opts.payeeKey);
  const sp = privateKeyToAccount(opts.spKey);
  const stranger = privateKeyToAccount(KEYS.stranger);
  const mode = opts.mode ?? {};
  const resource = opts.resource ?? 'GET /predict';
  const [resMethod, resPath] = resource.split(' ');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const chainId = chainIdFromNetwork(opts.network);
  const domain: MandateDomain = { chainId, verifyingContract: opts.wallet };
  const state = { served: 0, requests: 0, offersSent: 0, mandates: [] as MandatePayload[] };
  const seen = new Set<string>();
  let baseUrl = '';

  const offer = (): PaymentRequirements => ({
    scheme: 'aep2',
    network: opts.network,
    amount: opts.price,
    asset: opts.token,
    payTo: payee.address,
    resource,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    extra: {
      wallet: opts.wallet,
      sp: baseUrl,
      spAddress: sp.address,
      settleWindowSeconds: opts.settleWindowSeconds,
      ...(opts.quoteId ? { quoteId: opts.quoteId } : {}),
    },
  });

  function sendOffer(res: ServerResponse, status: number, error?: string, detail?: Record<string, unknown>): void {
    state.offersSent++;
    const body: PaymentRequiredBody = {
      x402Version: 2,
      ...(error ? { error } : {}),
      accepts: [offer()],
      payment_model_context: paymentModelContext(error ?? 'mandate_required', detail),
    };
    json(res, status, body, { [HEADER.required]: encodeHeader(body) });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    state.requests++;
    const u = new URL(req.url ?? '/', 'http://stub');
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
    if (method === 'GET' && u.pathname.startsWith('/status/')) {
      const digest = u.pathname.slice('/status/'.length);
      if (mode.spStatus) return json(res, 200, { status: mode.spStatus, mandateDigest: digest });
      return json(res, 404, { error: 'not_found' });
    }
    if (method !== resMethod || u.pathname !== resPath) return json(res, 404, { error: 'not_found' });

    const current = offer();
    let read;
    try {
      read = readMandatePayment(req.headers);
    } catch (err) {
      return sendOffer(res, 400, 'invalid_payment', { message: (err as Error).message });
    }
    if (!read || (mode.legacyOnly && read.kind === 'x402')) return sendOffer(res, 402);

    if (read.kind === 'x402') {
      const a = read.payload.accepted;
      const same =
        a?.scheme === current.scheme &&
        a.network === current.network &&
        a.asset?.toLowerCase() === current.asset.toLowerCase() &&
        a.payTo?.toLowerCase() === current.payTo.toLowerCase() &&
        a.amount === current.amount &&
        a.resource === current.resource &&
        a.extra?.wallet?.toLowerCase() === current.extra.wallet.toLowerCase();
      if (!same) return sendOffer(res, 402, 'offer_mismatch');
    }

    const { mandate, payerSig } = read.kind === 'x402' ? read.payload.payload : read.payload;
    try {
      assertMandateShape(mandate);
    } catch (err) {
      return sendOffer(res, 400, 'invalid_payment', { message: (err as Error).message });
    }
    const t = now();
    if (mandate.payee.toLowerCase() !== current.payTo.toLowerCase()) return sendOffer(res, 402, 'invalid_payee');
    if (mandate.token.toLowerCase() !== current.asset.toLowerCase()) return sendOffer(res, 402, 'invalid_token');
    if (BigInt(mandate.amount) < BigInt(current.amount)) return sendOffer(res, 402, 'invalid_amount');
    if (mandate.deadline <= t + 30) return sendOffer(res, 402, 'mandate_expired');
    if (mandate.deadline < t + opts.settleWindowSeconds) {
      return sendOffer(res, 402, 'mandate_deadline_too_short', { settleWindowSeconds: opts.settleWindowSeconds });
    }
    if (mandate.ref.toLowerCase() !== resourceRef(resource, opts.quoteId).toLowerCase()) {
      return sendOffer(res, 402, 'invalid_ref');
    }
    let signer: Address;
    try {
      signer = await recoverMandateSigner(domain, mandate, payerSig);
    } catch {
      return sendOffer(res, 402, 'invalid_signature');
    }
    if (signer.toLowerCase() !== mandate.owner.toLowerCase()) return sendOffer(res, 402, 'invalid_signature');

    const digest = mandateDigest(domain, mandate);
    state.mandates.push({ mandate, payerSig });
    if (mode.replay409 || seen.has(digest)) return json(res, 409, { error: 'replay', mandateDigest: digest });
    seen.add(digest);

    if (mode.reject) return json(res, mode.reject.status, mode.reject.body);

    // ---- "enqueue" at the SP: sign the receipt ----
    let receipt: SpReceipt | undefined;
    const receiptMode = mode.receipt ?? 'ok';
    if (receiptMode !== 'missing') {
      let enqueueDeadline = Math.min(mandate.deadline, t + opts.settleWindowSeconds);
      if (receiptMode === 'late-deadline') enqueueDeadline = mandate.deadline + 3600;
      receipt = await signSpReceipt(receiptMode === 'wrong-sp' ? stranger : sp, domain, digest, enqueueDeadline);
      if (receiptMode === 'bad-sig') receipt = { ...receipt, spEnqueueSig: tamper(receipt.spEnqueueSig) };
    }
    state.served++;
    const body: Record<string, unknown> = { ok: true, resource, served: state.served };
    const headers: Record<string, string> = { 'cache-control': 'no-store, private' };
    if (receipt) {
      const info: SettlementInfo = {
        success: true,
        scheme: 'aep2',
        network: current.network,
        payer: mandate.owner,
        transaction: '',
        status: 'enqueued',
        mandateDigest: digest,
        spReceipt: receipt,
      };
      headers[HEADER.response] = encodeHeader(info);
      if (mode.bodyPayment) body.payment = { status: 'enqueued', spReceipt: receipt };
    }
    json(res, 200, body, headers);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(`stub payee error: ${String(err)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    address: payee.address,
    spAddress: sp.address,
    get served() {
      return state.served;
    },
    get requests() {
      return state.requests;
    },
    get offersSent() {
      return state.offersSent;
    },
    mandates: state.mandates,
    offer,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
