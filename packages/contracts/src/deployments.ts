import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';

/** EIP-712 domain (name, version) of an EIP-3009 token; x402 carries it in `extra`. */
export interface AssetDomain {
  name: string;
  version: string;
}

/**
 * What describes one network in packages/contracts/deployments/<name>.json:
 * the USDC to pay with and its EIP-712 domain. localhost.json is written by
 * the deploy script; base-sepolia.json is a committed static record (nothing
 * of ours is deployed there — Circle's USDC is the only contract involved).
 */
export interface DeploymentRecord {
  chainId: number;
  /** CAIP-2 id, e.g. 'eip155:84532'. */
  network: string;
  /** The EIP-3009 ERC-20 to settle in (MockUSDC locally, USDC on Base Sepolia). */
  usdc: Address;
  usdcDomain: AssetDomain;
  /** A facilitator known to serve this network (the payee example defaults to it). */
  facilitatorUrl?: string;
  deployer?: Address;
  blockNumber?: number;
  deployedAt: string;
  note?: string;
}

export const DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deployments');

export function deploymentPath(name: string): string {
  return resolve(DEPLOYMENTS_DIR, `${name}.json`);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Rejects records from before the x402 migration (they described an AEP2DebitWallet, not a token domain). */
export function assertDeploymentRecord(x: unknown, source = 'deployment record'): asserts x is DeploymentRecord {
  const r = x as Partial<DeploymentRecord> | null;
  const bad = (what: string): never => {
    throw new Error(`${source}: ${what}`);
  };
  if (!r || typeof r !== 'object') bad('not an object');
  if (!Number.isInteger(r!.chainId)) bad('chainId must be an integer');
  if (typeof r!.network !== 'string' || !r!.network.startsWith('eip155:')) bad('network must be a CAIP-2 eip155 id');
  if (typeof r!.usdc !== 'string' || !ADDRESS_RE.test(r!.usdc)) bad('usdc must be an address');
  const d = r!.usdcDomain;
  if (!d || typeof d.name !== 'string' || typeof d.version !== 'string') {
    bad('usdcDomain { name, version } is missing — this looks like a pre-x402 (AEP2) record; rerun the deploy script');
  }
}

/** `name` is 'localhost' | 'base-sepolia' | an absolute/relative path to a JSON file. */
export function readDeployment(name: string): DeploymentRecord {
  const path = name.endsWith('.json') ? resolve(name) : deploymentPath(name);
  if (!existsSync(path)) throw new Error(`no deployment record at ${path} (run the deploy script first)`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertDeploymentRecord(parsed, path);
  return parsed;
}

export function writeDeployment(name: string, record: DeploymentRecord): string {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const path = deploymentPath(name);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}
