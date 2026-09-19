import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from '@agentpay/core';
import { ChainClient, assertStartup, type TokenInfo } from './chain.js';
import { MEMORY_STORE_PATH, resolveConfig, type SPConfig } from './config.js';
import { Queue } from './queue.js';
import { createHttpServer, type ServerRuntime } from './server.js';
import { JsonlStore } from './store.js';
import { Worker, type TickResult } from './worker.js';

export type { SPConfig, ResolvedSPConfig } from './config.js';
export { MEMORY_STORE_PATH, SP_DEFAULTS, loadConfigFromEnv, resolveConfig } from './config.js';
export type { TickResult, ReconcileResult } from './worker.js';
export { JsonlStore, RECORD_STATUSES, isReservedStatus, isTerminalStatus } from './store.js';
export type { QueueRecord, RecordPatch, RecordStatus, StoreEvent } from './store.js';
export { Queue } from './queue.js';
export type { ClaimResult, Precheck } from './queue.js';
export { checkTerms, parseEnqueueBody } from './validate.js';
export type { EnqueueRequest, Failure, TermsOptions } from './validate.js';
export { enqueueDeadlineFor, issueReceipt } from './receipt.js';
export { ChainClient, WITHDRAW_DELAY_MARGIN_SECONDS, assertStartup, classifyError, parseSettleLogs } from './chain.js';
export type { TokenInfo, SettleItem } from './chain.js';
export { MAX_BODY_BYTES } from './server.js';

export interface SPHandle {
  /** Verifies the chain, recovers in-flight records, listens, starts the worker. */
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  /** Runs one settlement batch now (or joins the one in flight). */
  tick(): Promise<TickResult>;
  /** The SP signing address (must be authorized by each payer). */
  address: Address;
  /** 'http://127.0.0.1:<port>' once started, '' before. */
  url: string;
  store: JsonlStore;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export function createSP(config: SPConfig): SPHandle {
  const cfg = resolveConfig(config);
  const account = privateKeyToAccount(cfg.key);
  const chain = new ChainClient(cfg, account);
  const store = new JsonlStore(cfg.storePath === MEMORY_STORE_PATH ? undefined : cfg.storePath, cfg.log);
  const queue = new Queue(store);
  const worker = new Worker({ store, chain, cfg, log: cfg.log, clock: cfg.clock });

  const runtime: ServerRuntime & { url: string; port: number; started: boolean } = {
    tokens: [] as TokenInfo[],
    withdrawDelay: 0,
    url: '',
    port: cfg.port,
    started: false,
  };
  const server = createHttpServer({ cfg, account, chain, store, queue, worker, runtime: () => runtime });

  async function start(): Promise<{ url: string; port: number }> {
    if (runtime.started) return { url: runtime.url, port: runtime.port };
    const info = await assertStartup(chain, cfg);
    runtime.tokens = info.tokens;
    runtime.withdrawDelay = info.withdrawDelay;
    await worker.reconcile();
    await listen(server, cfg.port, cfg.host);
    const addr = server.address() as AddressInfo;
    const hostForUrl = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    runtime.port = addr.port;
    runtime.url = `http://${hostForUrl}:${addr.port}`;
    runtime.started = true;
    worker.start();
    cfg.log(
      `sp: ${account.address} listening on ${runtime.url} (chain ${cfg.chainId}, wallet ${cfg.wallet}, ` +
        `${store.size} record(s), window ${cfg.settleWindowSeconds}s, withdrawDelay ${info.withdrawDelay}s)`,
    );
    if (store.path) cfg.log(`sp: store ${store.path}`);
    else cfg.log('sp: store is MEMORY-ONLY - receipts will not survive a restart');
    return { url: runtime.url, port: runtime.port };
  }

  async function stop(): Promise<void> {
    if (!runtime.started) return;
    runtime.started = false;
    await worker.stop();
    await close(server);
    cfg.log(`sp: stopped ${runtime.url}`);
  }

  return {
    address: account.address,
    get url() {
      return runtime.url;
    },
    store,
    start,
    stop,
    tick: () => worker.tick(),
  };
}
