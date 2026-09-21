/**
 * Environment handling shared by the example payees (express.ts, vendor-sim):
 * chain, token, payee address and facilitator, from the environment first and
 * the deployment record second, plus the early warning when the facilitator
 * does not serve the network. Any failure exits the process with code 2, as
 * a misconfigured payee must not come up quietly and refuse every payment.
 *
 *   PAYEE_ADDRESS     where settlements go. Defaults to hardhat #2 on eip155:31337.
 *   FACILITATOR_URL   default http://127.0.0.1:3001, or the deployment record's facilitatorUrl
 *                     (https://x402.org/facilitator for base-sepolia)
 *   FACILITATOR_AUTH_TOKEN  optional bearer token for a self-hosted facilitator
 *   PAYEE_RPC_URL     JSON-RPC of NETWORK, read (never written) to decide the one settle retry;
 *                     default per network below (hardhat :8545, sepolia.base.org)
 *   NETWORK, USDC_ADDRESS, USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION
 *                     default: packages/contracts/deployments/${DEPLOYMENT ?? 'localhost'}.json
 */
import { readDeployment } from '@agentpay/contracts';
import type { Address, AssetDomain } from '@agentpay/core';

// Hardhat public dev account #2 ("payee") — local development only.
export const HARDHAT_PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
// Public read endpoints per network: the paywall only ever calls authorizationState.
export const DEFAULT_RPC: Record<string, string> = {
  'eip155:31337': 'http://127.0.0.1:8545',
  'eip155:84532': 'https://sepolia.base.org',
};

export interface PayeeEnv {
  network: string;
  asset: Address;
  assetDomain: AssetDomain;
  payTo: Address;
  facilitatorUrl: string;
  facilitatorAuthToken: string | undefined;
  /** undefined when no PAYEE_RPC_URL is set and the network has no default: a failed settlement is then final. */
  rpcUrl: string | undefined;
}

function fail(tag: string, message: string): never {
  console.error(`${tag}: ${message}`);
  process.exit(2);
}

function asAddress(tag: string, value: string | undefined, name: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(tag, `${name} is not an address: ${value ?? '(unset)'}`);
  return value as Address;
}

/** Reads the payee configuration from `env` (default process.env); `tag` prefixes the log lines. */
export function resolvePayeeEnv(env: NodeJS.ProcessEnv = process.env, tag = 'payee'): PayeeEnv {
  // ---- chain / token: env first, then the deployment record ----
  let network = env.NETWORK;
  let usdcAddress = env.USDC_ADDRESS;
  let assetDomain: AssetDomain | undefined =
    env.USDC_DOMAIN_NAME && env.USDC_DOMAIN_VERSION ? { name: env.USDC_DOMAIN_NAME, version: env.USDC_DOMAIN_VERSION } : undefined;
  let facilitatorUrl = env.FACILITATOR_URL;
  if (!network || !usdcAddress || !assetDomain || !facilitatorUrl) {
    const name = env.DEPLOYMENT ?? 'localhost';
    try {
      const d = readDeployment(name);
      network ??= d.network;
      usdcAddress ??= d.usdc;
      assetDomain ??= d.usdcDomain;
      facilitatorUrl ??= d.facilitatorUrl ?? 'http://127.0.0.1:3001';
    } catch (err) {
      fail(tag, `NETWORK / USDC_ADDRESS / USDC_DOMAIN_* unset and deployment '${name}' unreadable: ${(err as Error).message}`);
    }
  }
  const asset = asAddress(tag, usdcAddress, 'USDC_ADDRESS');
  const isLocal = network === 'eip155:31337';
  const payTo = asAddress(tag, env.PAYEE_ADDRESS ?? (isLocal ? HARDHAT_PAYEE : undefined), 'PAYEE_ADDRESS');
  const rpcUrl = env.PAYEE_RPC_URL ?? DEFAULT_RPC[network!];
  if (!rpcUrl) console.warn(`${tag}: no PAYEE_RPC_URL for ${network}; a failed settlement will not be retried`);
  return { network: network!, asset, assetDomain: assetDomain!, payTo, facilitatorUrl: facilitatorUrl!, facilitatorAuthToken: env.FACILITATOR_AUTH_TOKEN, rpcUrl };
}

/** Warns early (never throws) when the facilitator does not list exact/V2 on `network`, or cannot be reached. */
export async function warnIfFacilitatorUnsupported(facilitatorUrl: string, network: string, tag = 'payee'): Promise<void> {
  try {
    const res = await fetch(`${facilitatorUrl}/supported`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as { kinds?: Array<{ x402Version: number; scheme: string; network: string }> };
    const ok = s.kinds?.some((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network);
    if (!ok) console.warn(`${tag}: ${facilitatorUrl} does not list { x402Version: 2, scheme: 'exact', network: '${network}' }`);
  } catch (err) {
    console.warn(`${tag}: ${facilitatorUrl}/supported unreachable (${(err as Error).message}); paid calls will fail until it is up`);
  }
}
