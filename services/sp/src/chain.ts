import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEventLogs,
  type Chain,
  type HttpTransport,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { AEP2_DEBIT_WALLET_ABI, SETTLE_STATUS } from '@agentpay/contracts';
import { mandateToTuple, type Address, type Hex, type Mandate } from '@agentpay/core';
import type { ResolvedSPConfig } from './config.js';

/** What the worker needs from a record to build a settle call. */
export interface SettleItem {
  mandate: Mandate;
  payerSig: Hex;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

const ERC20_META_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Named revert (custom error) -> contract SettleStatus index. */
export const REVERT_STATUS: Record<string, number> = {
  SPNotAuthorized: 1,
  Expired: 2,
  NonceUsed: 3,
  InsufficientBalance: 4,
  BadSignature: 5,
  BadParams: 6,
};

export function statusName(status: number): string {
  return SETTLE_STATUS[status] ?? `status_${status}`;
}

export type ErrorKind =
  /** The EVM rejected the call: deterministic, retrying changes nothing. */
  | { kind: 'revert'; errorName?: string; message: string }
  /** Transport / node / signing trouble: worth retrying later. */
  | { kind: 'transport'; message: string };

export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return { kind: 'revert', errorName: reverted.data?.errorName, message: reverted.shortMessage };
    }
    if (err.walk((e) => e instanceof ExecutionRevertedError)) return { kind: 'revert', message: err.shortMessage };
  }
  return { kind: 'transport', message: errorMessage(err) };
}

export interface SettleLogs {
  /** Lowercased digests with a Settled event in the receipt. */
  settled: Set<string>;
  /** Lowercased digest -> SettleStatus index, from SettleSkipped events. */
  skipped: Map<string, number>;
}

export function parseSettleLogs(receipt: TransactionReceipt): SettleLogs {
  const settled = new Set<string>();
  const skipped = new Map<string, number>();
  for (const log of parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'Settled' })) {
    settled.add(log.args.mandateDigest.toLowerCase());
  }
  for (const log of parseEventLogs({ abi: AEP2_DEBIT_WALLET_ABI, logs: receipt.logs, eventName: 'SettleSkipped' })) {
    skipped.set(log.args.mandateDigest.toLowerCase(), Number(log.args.status));
  }
  return { settled, skipped };
}

export type ChainConfig = Pick<ResolvedSPConfig, 'rpcUrl' | 'chainId' | 'wallet' | 'pollingIntervalMs'>;

/** viem clients plus the handful of wallet-contract calls the SP makes. */
export class ChainClient {
  readonly publicClient: PublicClient<HttpTransport, Chain>;
  readonly walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;

  constructor(
    readonly cfg: ChainConfig,
    readonly account: PrivateKeyAccount,
  ) {
    const chain = defineChain({
      id: cfg.chainId,
      name: `eip155:${cfg.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    // No transport retries: the worker has its own backoff, and dev nodes report
    // deterministic reverts with a retryable-looking JSON-RPC code.
    const transport = http(cfg.rpcUrl, { retryCount: 0 });
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: cfg.pollingIntervalMs });
    this.walletClient = createWalletClient({ chain, transport, account, pollingInterval: cfg.pollingIntervalMs });
  }

  chainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  /** Uncached: admission reads are pinned to this block, so it must be the node's real head. */
  async blockNumber(): Promise<number> {
    return Number(await this.publicClient.getBlockNumber({ cacheTime: 0 }));
  }

  async withdrawDelay(): Promise<number> {
    const delay = await this.publicClient.readContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'withdrawDelay',
    });
    return Number(delay);
  }

  /** decimals() must answer; a missing/odd symbol() is tolerated. */
  async tokenInfo(token: Address): Promise<TokenInfo> {
    const decimals = await this.publicClient.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'decimals' });
    let symbol = 'UNKNOWN';
    try {
      symbol = await this.publicClient.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'symbol' });
    } catch {
      /* non-standard symbol() */
    }
    return { address: token, symbol, decimals: Number(decimals) };
  }

  /**
   * Admission reads accept an explicit block so all three facts come from the
   * same chain view, and so a lagging RPC replica can be refused (see server.ts).
   */
  isAuthorized(owner: Address, at?: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'authorizedSP',
      args: [owner, this.account.address],
      ...(at !== undefined ? { blockNumber: at } : {}),
    });
  }

  nonceUsed(owner: Address, nonce: string, at?: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'usedNonces',
      args: [owner, BigInt(nonce)],
      ...(at !== undefined ? { blockNumber: at } : {}),
    });
  }

  debitable(owner: Address, token: Address, at?: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'debitableBalance',
      args: [owner, token],
      ...(at !== undefined ? { blockNumber: at } : {}),
    });
  }

  balance(owner: Address, token: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'balances',
      args: [owner, token],
    });
  }

  private batchArgs(items: readonly SettleItem[]) {
    return [items.map((i) => mandateToTuple(i.mandate)), items.map((i) => i.payerSig)] as const;
  }

  /** eth_call of settleBatch as the SP: per-item SettleStatus without spending gas. */
  async simulateSettleBatch(items: readonly SettleItem[]): Promise<number[]> {
    const { result } = await this.publicClient.simulateContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settleBatch',
      args: this.batchArgs(items),
      account: this.account,
    });
    return [...result].map(Number);
  }

  sendSettleBatch(items: readonly SettleItem[]): Promise<Hex> {
    return this.walletClient.writeContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settleBatch',
      args: this.batchArgs(items),
    });
  }

  sendSettle(item: SettleItem): Promise<Hex> {
    return this.walletClient.writeContract({
      address: this.cfg.wallet,
      abi: AEP2_DEBIT_WALLET_ABI,
      functionName: 'settle',
      args: [mandateToTuple(item.mandate), item.payerSig],
    });
  }

  waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
    return this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  }

  /** undefined when the transaction is not (yet) mined. */
  async getReceipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    try {
      return await this.publicClient.getTransactionReceipt({ hash });
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof TransactionReceiptNotFoundError)) return undefined;
      throw err;
    }
  }

  /** Hash of the transaction that emitted Settled for this digest at or after fromBlock, if any. */
  async findSettledTx(owner: Address, digest: Hex, fromBlock: number): Promise<Hex | undefined> {
    try {
      const logs = await this.publicClient.getContractEvents({
        address: this.cfg.wallet,
        abi: AEP2_DEBIT_WALLET_ABI,
        eventName: 'Settled',
        args: { owner },
        fromBlock: BigInt(fromBlock),
        toBlock: 'latest',
      });
      const hit = logs.find((l) => (l.args.mandateDigest ?? '').toLowerCase() === digest.toLowerCase());
      return hit?.transactionHash ?? undefined;
    } catch {
      return undefined;
    }
  }
}

export interface StartupInfo {
  withdrawDelay: number;
  tokens: TokenInfo[];
}

/** Startup invariants; throws an Error whose message says exactly what is wrong. */
export async function assertStartup(
  chain: ChainClient,
  cfg: Pick<ResolvedSPConfig, 'rpcUrl' | 'chainId' | 'wallet' | 'tokens' | 'settleWindowSeconds'>,
): Promise<StartupInfo> {
  let chainId: number;
  try {
    chainId = await chain.chainId();
  } catch (err) {
    throw new Error(`cannot reach RPC ${cfg.rpcUrl}: ${errorMessage(err)}`);
  }
  if (chainId !== cfg.chainId) {
    throw new Error(`RPC ${cfg.rpcUrl} serves chain ${chainId} but the configuration says ${cfg.chainId}`);
  }
  let withdrawDelay: number;
  try {
    withdrawDelay = await chain.withdrawDelay();
  } catch (err) {
    throw new Error(
      `wallet ${cfg.wallet} does not answer withdrawDelay() (is it an AEP2DebitWallet on chain ${chainId}?): ${errorMessage(err)}`,
    );
  }
  if (withdrawDelay < cfg.settleWindowSeconds) {
    throw new Error(
      `wallet withdrawDelay is ${withdrawDelay}s but settleWindowSeconds is ${cfg.settleWindowSeconds}s: ` +
        'enqueued mandates could outlive the withdrawal lock; lower SETTLE_WINDOW',
    );
  }
  const tokens: TokenInfo[] = [];
  for (const token of cfg.tokens) {
    try {
      tokens.push(await chain.tokenInfo(token));
    } catch (err) {
      throw new Error(`token ${token} does not answer decimals(): ${errorMessage(err)}`);
    }
  }
  return { withdrawDelay, tokens };
}
