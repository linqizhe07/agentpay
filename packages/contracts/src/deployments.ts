import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';

/** What a deploy script writes to packages/contracts/deployments/<name>.json. */
export interface DeploymentRecord {
  chainId: number;
  /** CAIP-2 id, e.g. 'eip155:84532'. */
  network: string;
  wallet: Address;
  /** The ERC-20 the deployment is meant to settle (MockUSDC locally, USDC on Base Sepolia). */
  usdc: Address;
  withdrawDelay: number;
  deployer: Address;
  txHash: Hex;
  blockNumber: number;
  deployedAt: string;
}

export const DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deployments');

export function deploymentPath(name: string): string {
  return resolve(DEPLOYMENTS_DIR, `${name}.json`);
}

/** `name` is 'localhost' | 'base-sepolia' | an absolute/relative path to a JSON file. */
export function readDeployment(name: string): DeploymentRecord {
  const path = name.endsWith('.json') ? resolve(name) : deploymentPath(name);
  if (!existsSync(path)) throw new Error(`no deployment record at ${path} (run the deploy script first)`);
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
}

export function writeDeployment(name: string, record: DeploymentRecord): string {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const path = deploymentPath(name);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}
