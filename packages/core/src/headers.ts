import { WireError } from './errors.js';
import type {
  MandatePayload,
  PaymentPayload,
  PaymentRequiredBody,
  SettlementInfo,
} from './types.js';

/**
 * Wire header names. We emit the x402 V2 names and additionally accept FluxA's
 * legacy `X-Payment-Mandate` (a bare base64 {mandate, payerSig}) on read.
 * Nothing outside this module may hardcode header strings.
 */
export const HEADER = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
  legacyMandate: 'X-Payment-Mandate',
} as const;

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export function decodeHeader<T>(value: string): T {
  try {
    const json = Buffer.from(value, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  } catch (err) {
    throw new WireError(`malformed base64/JSON header: ${(err as Error).message}`);
  }
}

/** Node's req.headers bag, a fetch Headers object, or any case-insensitive-ish map. */
export type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

function lookup(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === lower) {
      const v = bag[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export function readHeader(headers: HeaderBag, name: string): string | undefined {
  return lookup(headers, name);
}

export type ReadMandateResult =
  | { kind: 'x402'; payload: PaymentPayload }
  | { kind: 'legacy'; payload: MandatePayload };

function isMandatePayloadShape(x: unknown): x is MandatePayload {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as { mandate?: unknown; payerSig?: unknown };
  return typeof o.mandate === 'object' && o.mandate !== null && typeof o.payerSig === 'string';
}

/**
 * Reads the payer's mandate from PAYMENT-SIGNATURE (x402 V2 envelope with an
 * echoed offer) or, failing that, from the legacy X-Payment-Mandate header.
 * Returns undefined when neither header is present; throws WireError on garbage.
 */
export function readMandatePayment(headers: HeaderBag): ReadMandateResult | undefined {
  const x402 = lookup(headers, HEADER.signature);
  if (x402 !== undefined) {
    const payload = decodeHeader<PaymentPayload>(x402);
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !isMandatePayloadShape((payload as PaymentPayload).payload)
    ) {
      throw new WireError('payment payload missing mandate/payerSig');
    }
    return { kind: 'x402', payload };
  }
  const legacy = lookup(headers, HEADER.legacyMandate);
  if (legacy !== undefined) {
    const payload = decodeHeader<MandatePayload>(legacy);
    if (!isMandatePayloadShape(payload)) {
      throw new WireError('X-Payment-Mandate missing mandate/payerSig');
    }
    return { kind: 'legacy', payload };
  }
  return undefined;
}

/** Reads the payee's PAYMENT-RESPONSE header; undefined when absent, WireError when malformed. */
export function readPaymentResponse(headers: HeaderBag): SettlementInfo | undefined {
  const raw = lookup(headers, HEADER.response);
  if (raw === undefined) return undefined;
  const decoded = decodeHeader<SettlementInfo>(raw);
  if (decoded === null || typeof decoded !== 'object') {
    throw new WireError('PAYMENT-RESPONSE is not an object');
  }
  return decoded;
}

/** Reads the 402 offer: PAYMENT-REQUIRED header first, JSON body as fallback. */
export function readPaymentRequired(headers: HeaderBag, bodyText?: string): PaymentRequiredBody {
  const raw = lookup(headers, HEADER.required);
  if (raw !== undefined) return decodeHeader<PaymentRequiredBody>(raw);
  if (bodyText) {
    try {
      return JSON.parse(bodyText) as PaymentRequiredBody;
    } catch {
      /* fall through */
    }
  }
  throw new WireError('402 response carries no PAYMENT-REQUIRED header or JSON body');
}
