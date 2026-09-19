/**
 * A node:http double of the x402 facilitator API for the offline suites:
 * /supported, /verify and /settle with a switchable `mode`, recording every
 * call. `ok` mode checks what an honest facilitator would check without a
 * chain (signature, recipient, value, window) and refuses a nonce it has
 * already settled.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyTypedData, type Hex } from 'viem';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

export type StubMode =
  | { kind: 'ok' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'settle-fail'; reason: string }
  | { kind: 'settle-pending' }
  | { kind: 'settle-down' }
  | { kind: 'http-500' }
  | { kind: 'http-503-reason' }
  | { kind: 'down' }
  | { kind: 'slow'; ms: number };

export interface StubCall {
  route: 'verify' | 'settle';
  body: { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  headers: Record<string, string | string[] | undefined>;
}

export interface StubFacilitator {
  url: string;
  address: `0x${string}`;
  mode: StubMode;
  calls: StubCall[];
  settled: Set<string>;
  close(): Promise<void>;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function fakeTx(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function startStubFacilitator(opts: { network: string; address: `0x${string}` }): Promise<StubFacilitator> {
  const state: { mode: StubMode } = { mode: { kind: 'ok' } };
  const calls: StubCall[] = [];
  const settled = new Set<string>();

  async function honestVerify(body: StubCall['body']): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
    const req = body.paymentRequirements;
    const p = body.paymentPayload.payload as { signature: Hex; authorization: Record<string, string> };
    const a = p.authorization;
    const payer = a.from;
    if (req.scheme !== 'exact') return { isValid: false, invalidReason: 'invalid_exact_evm_scheme', payer };
    if (body.paymentPayload.accepted.network !== req.network) return { isValid: false, invalidReason: 'invalid_exact_evm_network_mismatch', payer };
    const chainId = Number(req.network.split(':')[1]);
    const ok = await verifyTypedData({
      address: a.from as Hex,
      domain: { name: String(req.extra.name), version: String(req.extra.version), chainId, verifyingContract: req.asset as Hex },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as Hex,
        to: a.to as Hex,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce as Hex,
      },
      signature: p.signature,
    }).catch(() => false);
    if (!ok) return { isValid: false, invalidReason: 'invalid_exact_evm_signature', payer };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: 'invalid_exact_evm_recipient_mismatch', payer };
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(a.validBefore) < BigInt(now + 6)) return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_before', payer };
    if (BigInt(a.validAfter) > BigInt(now)) return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_valid_after', payer };
    if (BigInt(a.value) !== BigInt(req.amount)) return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value_mismatch', payer };
    if (settled.has(`${a.from}:${a.nonce}`.toLowerCase())) return { isValid: false, invalidReason: 'invalid_exact_evm_nonce_already_used', payer };
    return { isValid: true, payer };
  }

  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/supported') {
      return json(200, {
        kinds: [{ x402Version: 2, scheme: 'exact', network: opts.network }],
        extensions: [],
        signers: { 'eip155:*': [opts.address] },
      });
    }
    const route = url.pathname === '/verify' ? 'verify' : url.pathname === '/settle' ? 'settle' : undefined;
    if (!route || req.method !== 'POST') return json(404, { error: 'not_found' });

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StubCall['body'];
      calls.push({ route, body, headers: req.headers });
      const mode = state.mode;
      const network = body.paymentRequirements.network;
      const a = (body.paymentPayload.payload as { authorization: Record<string, string> }).authorization;
      const key = `${a.from}:${a.nonce}`.toLowerCase();
      switch (mode.kind) {
        case 'down':
          req.socket.destroy();
          return;
        case 'http-500':
          return json(500, { error: 'boom' });
        case 'http-503-reason':
          return route === 'verify'
            ? json(503, { isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: 'rpc down' })
            : json(503, { success: false, errorReason: 'unexpected_settle_error', transaction: '', network });
        case 'settle-down':
          if (route === 'settle') {
            req.socket.destroy();
            return;
          }
          break;
        case 'slow':
          await new Promise((r) => setTimeout(r, mode.ms));
          break;
        default:
          break;
      }
      if (route === 'verify') {
        if (mode.kind === 'invalid') return json(200, { isValid: false, invalidReason: mode.reason, payer: a.from });
        return json(200, await honestVerify(body));
      }
      // settle
      if (mode.kind === 'invalid') return json(200, { success: false, errorReason: mode.reason, transaction: '', network, payer: a.from });
      if (mode.kind === 'settle-fail') return json(200, { success: false, errorReason: mode.reason, transaction: '', network, payer: a.from });
      if (mode.kind === 'settle-pending') return json(200, { success: false, errorReason: 'settlement_pending', transaction: fakeTx(), network, payer: a.from });
      const v = await honestVerify(body);
      if (!v.isValid) return json(200, { success: false, errorReason: v.invalidReason, transaction: '', network, payer: a.from });
      settled.add(key);
      return json(200, { success: true, transaction: fakeTx(), network, payer: a.from });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    address: opts.address,
    get mode() {
      return state.mode;
    },
    set mode(m: StubMode) {
      state.mode = m;
    },
    calls,
    settled,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
