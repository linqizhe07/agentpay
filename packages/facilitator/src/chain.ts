import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createWalletClient,
  defineChain,
  domainSeparator,
  http,
  nonceManager,
  parseAbi,
  publicActions,
  verifyTypedData as verifyTypedDataOffline,
  type Chain,
  type HttpTransport,
  type PublicActions,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from '@x402/evm';
import { EIP3009_ABI, type Address, type AssetDomain } from '@agentpay/core';
import type { ResolvedFacilitatorConfig } from './config.js';

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

const ERC20_META_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);

export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True for RPC transport trouble (worth a retry), false for anything the chain decided. */
export function isTransportError(err: unknown): boolean {
  if (err instanceof BaseError) {
    return err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/**
 * Serialises the sign-and-broadcast step. viem's nonce manager hands out
 * sequential nonces, but it does so before gas estimation and resets on any
 * failure, and Hardhat's automine rejects a transaction whose nonce is ahead
 * of the expected one: two settlements racing through writeContract can hit
 * "Nonce too high". Receipts are awaited outside the lock, so throughput is
 * still one broadcast per RPC round trip, not one per block.
 */
export function createSendLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export type ChainConfig = Pick<ResolvedFacilitatorConfig, 'rpcUrl' | 'chainId' | 'pollingIntervalMs' | 'receiptTimeoutMs'>;

type Client = WalletClient<HttpTransport, Chain, PrivateKeyAccount> & PublicActions<HttpTransport, Chain, PrivateKeyAccount>;

/** viem clients, the facilitator account, and the signer object @x402/evm settles through. */
export class ChainClient {
  readonly account: PrivateKeyAccount;
  readonly client: Client;
  readonly signer: FacilitatorEvmSigner;
  /**
   * Bumped whenever a chain call fails for transport reasons. @x402/evm folds
   * every failed read into a refusal reason, so the HTTP layer compares this
   * counter before and after a verify/settle to tell "the chain said no"
   * from "the chain could not be reached".
   */
  transportErrors = 0;

  constructor(readonly cfg: ChainConfig, key: `0x${string}`) {
    this.account = privateKeyToAccount(key, { nonceManager });
    const chain = defineChain({
      id: cfg.chainId,
      name: `eip155:${cfg.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    // No transport retries: dev nodes report deterministic reverts with a
    // retryable-looking JSON-RPC code, and a settle must not be re-broadcast
    // blindly. pollingInterval matters: without it viem polls every
    // blockTime/3 with blockTime defaulting to 12 s, i.e. 4 s per receipt check.
    const transport = http(cfg.rpcUrl, { retryCount: 0 });
    this.client = createWalletClient({
      chain,
      transport,
      account: this.account,
      pollingInterval: cfg.pollingIntervalMs,
    }).extend(publicActions) as Client;

    const lock = createSendLock();
    const c = this.client;
    const counted = <T>(p: Promise<T>): Promise<T> =>
      p.catch((err: unknown) => {
        if (isTransportError(err)) this.transportErrors++;
        throw err;
      });
    this.signer = toFacilitatorEvmSigner(
      {
        address: this.account.address,
        readContract: (args) => counted(c.readContract(args as never)),
        // An EOA signature verifies offline; only a contract wallet's needs the
        // chain (EIP-1271 / 6492), so an RPC outage cannot turn a good
        // signature into invalid_exact_evm_signature.
        verifyTypedData: async (args) =>
          (await verifyTypedDataOffline(args as never).catch(() => false)) || counted(c.verifyTypedData(args as never)),
        writeContract: (args) => counted(lock(() => c.writeContract(args as never))),
        sendTransaction: (args) => counted(lock(() => c.sendTransaction(args as never))),
        waitForTransactionReceipt: (args) => counted(c.waitForTransactionReceipt(args)),
        getCode: (args) => counted(c.getCode(args)),
      },
      { confirmationTimeoutMs: cfg.receiptTimeoutMs },
    );
  }

  chainId(): Promise<number> {
    return this.client.getChainId();
  }

  ethBalance(): Promise<bigint> {
    return this.client.getBalance({ address: this.account.address });
  }

  async tokenInfo(token: Address): Promise<TokenInfo> {
    const decimals = await this.client.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'decimals' });
    let symbol = '?';
    try {
      symbol = await this.client.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'symbol' });
    } catch {
      /* symbol() is optional in ERC-20 */
    }
    return { address: token, symbol, decimals };
  }

  /** Proves `token` is an EIP-3009 contract: authorizationState() answers for a never-used nonce. */
  async assertEip3009(token: Address): Promise<void> {
    const used = await this.client.readContract({
      address: token,
      abi: EIP3009_ABI,
      functionName: 'authorizationState',
      args: [this.account.address, `0x${'00'.repeat(32)}`],
    });
    if (used !== false) throw new Error('authorizationState() did not answer false for an unused nonce');
  }

  /**
   * Checks that `domain` is what the token signs under: via eip712Domain()
   * (ERC-5267, what OpenZeppelin exposes) or, for Circle's FiatToken, by
   * recomputing DOMAIN_SEPARATOR() from name/version. A wrong domain would
   * otherwise fail every payment as invalid_exact_evm_signature.
   */
  async assertAssetDomain(token: Address, domain: AssetDomain): Promise<void> {
    const expected = domainSeparator({
      domain: { name: domain.name, version: domain.version, chainId: this.cfg.chainId, verifyingContract: token },
    });
    let actual: `0x${string}` | undefined;
    try {
      const [, name, version, chainId, verifyingContract] = await this.client.readContract({
        address: token,
        abi: ERC20_META_ABI,
        functionName: 'eip712Domain',
      });
      actual = domainSeparator({ domain: { name, version, chainId: Number(chainId), verifyingContract } });
    } catch {
      actual = await this.client.readContract({ address: token, abi: ERC20_META_ABI, functionName: 'DOMAIN_SEPARATOR' });
    }
    if (actual !== expected) {
      throw new Error(
        `token ${token} does not sign under { name: ${JSON.stringify(domain.name)}, version: ${JSON.stringify(domain.version)} } ` +
          `(separator ${actual} vs expected ${expected})`,
      );
    }
  }
}

export interface StartupInfo {
  tokens: TokenInfo[];
  ethBalance: bigint;
}

/** Startup invariants; throws an Error whose message says exactly what is wrong. */
export async function assertStartup(
  chain: ChainClient,
  cfg: Pick<ResolvedFacilitatorConfig, 'rpcUrl' | 'chainId' | 'tokens' | 'assetDomain'>,
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
  const tokens: TokenInfo[] = [];
  for (const token of cfg.tokens) {
    try {
      tokens.push(await chain.tokenInfo(token));
      await chain.assertEip3009(token);
    } catch (err) {
      throw new Error(`token ${token} is not an EIP-3009 ERC-20 on chain ${chainId}: ${errorMessage(err)}`);
    }
  }
  if (cfg.assetDomain) await chain.assertAssetDomain(cfg.tokens[0]!, cfg.assetDomain);
  const ethBalance = await chain.ethBalance();
  if (ethBalance === 0n) {
    throw new Error(`facilitator ${chain.account.address} has no ETH on chain ${chainId}: it cannot pay for settlements`);
  }
  return { tokens, ethBalance };
}
