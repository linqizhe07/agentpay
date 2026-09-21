/**
 * In-process x402 payee for the wallet suites: the real @agentpay/payee
 * paywall on express, backed by the payee package's stub facilitator (no
 * chain). `mode` steers the facilitator; the `/raw` route bypasses the
 * paywall to produce the malformed successes a wallet must survive.
 */
import express from 'express';
import type { Server } from 'node:http';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { createPaywall } from '@agentpay/payee';
import type { Address, AssetDomain } from '@agentpay/core';
import { startStubFacilitator, type StubFacilitator, type StubMode } from '../../payee/test/stub-facilitator.js';

export { KEYS } from '../../payee/test/helpers.js';

export type RawMode = 'no-response-header' | 'malformed-response' | 'wrong-network' | 'success-false' | 'settlement-pending' | 'fake-success';

export interface StubPayeeOptions {
  payTo: Address;
  token: Address;
  assetDomain: AssetDomain;
  network: string;
  /** Human price for /predict and /analyze, e.g. '$0.001'. */
  price: string;
  maxTimeoutSeconds?: number;
  facilitatorAddress: Address;
  /** What the /raw route does once a payment header is present. */
  rawMode?: RawMode;
  /** Handler status for /predict (>= 400 cancels the settlement). */
  handlerStatus?: number;
  /** Size of the JSON body GET /big answers with (default 100 000 bytes): what `--save` is for. */
  bigBytes?: number;
}

export interface StubPayee {
  url: string;
  address: Address;
  facilitator: StubFacilitator;
  /** Facilitator behaviour; `{ kind: 'ok' }` by default. */
  mode: StubMode;
  requests: number;
  served: number;
  /** Every payment payload the payee received, in order. */
  payments: PaymentPayload[];
  close(): Promise<void>;
}

export async function startStubPayee(opts: StubPayeeOptions): Promise<StubPayee> {
  const facilitator = await startStubFacilitator({ network: opts.network, address: opts.facilitatorAddress });
  const state = { requests: 0, served: 0, payments: [] as PaymentPayload[] };
  const paywall = createPaywall({
    facilitator: { url: facilitator.url, timeoutMs: 2_000 },
    network: opts.network,
    asset: opts.token,
    assetDomain: opts.assetDomain,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
    log: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    state.requests++;
    const header = req.header('PAYMENT-SIGNATURE');
    if (header) {
      try {
        state.payments.push(decodePaymentSignatureHeader(header));
      } catch {
        /* garbage: the paywall answers */
      }
    }
    next();
  });
  app.get('/predict', paywall.charge(opts.price, { description: 'a prediction' }), (_req, res) => {
    state.served++;
    res.status(opts.handlerStatus ?? 200).json({ ok: true, resource: 'GET /predict', served: state.served });
  });
  // A paid body far past the 8 KB a tool result carries: `{"rows":[...],"pad":"xxxx…"}` padded to exactly bigBytes.
  app.get('/big', paywall.charge(opts.price, { description: 'a big download' }), (_req, res) => {
    state.served++;
    const size = opts.bigBytes ?? 100_000;
    const head = JSON.stringify({ rows: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }], served: state.served, pad: '' });
    const body = head.slice(0, -2) + 'x'.repeat(Math.max(0, size - head.length)) + '"}';
    res.status(opts.handlerStatus ?? 200).type('application/json').send(body);
  });
  app.post('/analyze', paywall.charge(opts.price), (req, res) => {
    state.served++;
    res.json({ ok: true, echo: req.body });
  });
  // A payee that answers the offer correctly but then reports settlement badly.
  app.get('/raw', (req, res) => {
    if (!req.header('PAYMENT-SIGNATURE')) {
      const amount = String(Math.round(Number(opts.price.replace('$', '')) * 1_000_000));
      res.setHeader(
        'PAYMENT-REQUIRED',
        encodePaymentRequiredHeader({
          x402Version: 2,
          error: 'Payment required',
          resource: { url: `${req.protocol}://${req.headers.host}${req.originalUrl}` },
          accepts: [
            {
              scheme: 'exact',
              network: opts.network as `${string}:${string}`,
              asset: opts.token,
              amount,
              payTo: opts.payTo,
              maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
              extra: { ...opts.assetDomain, assetTransferMethod: 'eip3009' },
            },
          ],
        }),
      );
      res.status(402).json({});
      return;
    }
    state.served++;
    const tx = `0x${'ab'.repeat(32)}`;
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    switch (opts.rawMode ?? 'no-response-header') {
      case 'malformed-response':
        res.setHeader('PAYMENT-RESPONSE', 'not-base64-json');
        break;
      case 'wrong-network':
        res.setHeader('PAYMENT-RESPONSE', encode({ success: true, transaction: tx, network: 'eip155:84532', payer: opts.payTo }));
        break;
      case 'success-false':
        res.setHeader('PAYMENT-RESPONSE', encode({ success: false, errorReason: 'invalid_exact_evm_transaction_failed', transaction: '', network: opts.network }));
        break;
      case 'settlement-pending':
        res.setHeader('PAYMENT-RESPONSE', encode({ success: false, errorReason: 'settlement_pending', transaction: tx, network: opts.network }));
        res.status(402).json({});
        return;
      case 'fake-success': {
        // A payee that claims a settlement it never made.
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const fake = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
        res.setHeader('PAYMENT-RESPONSE', encode({ success: true, transaction: fake, network: opts.network, payer: opts.payTo }));
        break;
      }
      case 'no-response-header':
      default:
        break;
    }
    res.json({ ok: true, raw: true });
  });

  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no ephemeral port');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    address: opts.payTo,
    facilitator,
    get mode() {
      return facilitator.mode;
    },
    set mode(m: StubMode) {
      facilitator.mode = m;
    },
    get requests() {
      return state.requests;
    },
    get served() {
      return state.served;
    },
    payments: state.payments,
    close: async () => {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await facilitator.close();
    },
  };
}
