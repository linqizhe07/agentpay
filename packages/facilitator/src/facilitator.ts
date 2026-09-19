import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { X402_SCHEME, type Address } from '@agentpay/core';
import type { ChainClient } from './chain.js';
import type { ResolvedFacilitatorConfig } from './config.js';

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Why this facilitator will not touch a request, before any chain call:
 * the wrong scheme/network for this instance, an asset it does not settle,
 * or (when configured) a recipient it does not settle for.
 */
export function refusalReason(cfg: ResolvedFacilitatorConfig, requirements: PaymentRequirements): string | undefined {
  if (requirements.scheme !== X402_SCHEME) return 'unsupported_scheme';
  if (requirements.network !== cfg.network) return 'invalid_network';
  if (!cfg.tokens.some((t) => eqAddr(t, requirements.asset))) return 'unsupported_asset';
  if (cfg.payees && !cfg.payees.some((p) => eqAddr(p, requirements.payTo))) return 'unsupported_payee';
  return undefined;
}

/** True when the payload is at least the x402 V2 envelope (@x402/evm validates the rest). */
export function isPayloadShape(x: unknown): x is PaymentPayload {
  const p = x as Partial<PaymentPayload> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    p.x402Version === 2 &&
    !!p.accepted &&
    typeof p.accepted === 'object' &&
    !!p.payload &&
    typeof p.payload === 'object'
  );
}

export function isRequirementsShape(x: unknown): x is PaymentRequirements {
  const r = x as Partial<PaymentRequirements> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.scheme === 'string' &&
    typeof r.network === 'string' &&
    typeof r.asset === 'string' &&
    typeof r.amount === 'string' &&
    typeof r.payTo === 'string' &&
    typeof r.maxTimeoutSeconds === 'number' &&
    !!r.extra &&
    typeof r.extra === 'object'
  );
}

/**
 * The official x402 facilitator core with the EIP-3009 `exact` scheme on this
 * chain, gated by the asset / payee allowlists. Anything reaching `verify` or
 * `settle` through this object (the HTTP routes or an in-process caller) is
 * refused the same way.
 */
export function buildFacilitator(cfg: ResolvedFacilitatorConfig, chain: ChainClient): x402Facilitator {
  const facilitator = new x402Facilitator();
  // Registered directly rather than through registerExactEvmScheme(), which
  // would also advertise the V1 scheme on every network it knows: this
  // facilitator speaks x402 V2 on one chain.
  facilitator.register(
    [cfg.network],
    new ExactEvmScheme(chain.signer, {
      // Simulate again right before broadcasting: a revert caught here never
      // consumes a nonce, so a bad authorization cannot wedge later settlements.
      simulateInSettle: true,
    }),
  );
  facilitator.onBeforeVerify(async ({ requirements }) => {
    const reason = refusalReason(cfg, requirements);
    return reason ? { abort: true, reason } : undefined;
  });
  facilitator.onBeforeSettle(async ({ requirements }) => {
    const reason = refusalReason(cfg, requirements);
    return reason ? { abort: true, reason } : undefined;
  });
  return facilitator;
}

export type { Address };
