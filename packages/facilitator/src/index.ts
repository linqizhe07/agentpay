import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { x402Facilitator } from '@x402/core/facilitator';
import type { Address } from '@agentpay/core';
import { ChainClient, assertStartup, type TokenInfo } from './chain.js';
import { resolveConfig, type FacilitatorConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { createHttpServer, type ServerRuntime } from './server.js';

export type { FacilitatorConfig, ResolvedFacilitatorConfig } from './config.js';
export { FACILITATOR_DEFAULTS, loadConfigFromEnv, resolveConfig } from './config.js';
export { ChainClient, assertStartup, createSendLock, errorMessage, isTransportError } from './chain.js';
export type { TokenInfo } from './chain.js';
export { buildFacilitator, refusalReason } from './facilitator.js';
export { MAX_BODY_BYTES } from './server.js';

export interface FacilitatorHandle {
  /** Verifies the chain and the configured token, then listens. */
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  /** The account that broadcasts settlements (needs ETH). */
  address: Address;
  /** 'http://127.0.0.1:<port>' once started, '' before. */
  url: string;
  /** The underlying @x402/core facilitator, for in-process use. */
  facilitator: x402Facilitator;
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

export function createFacilitator(config: FacilitatorConfig): FacilitatorHandle {
  const cfg = resolveConfig(config);
  const chain = new ChainClient(cfg, cfg.key);
  const facilitator = buildFacilitator(cfg, chain);

  const runtime: ServerRuntime & { url: string; port: number; started: boolean } = {
    tokens: [] as TokenInfo[],
    url: '',
    port: cfg.port,
    started: false,
  };
  const server = createHttpServer({ cfg, chain, facilitator, runtime: () => runtime });

  async function start(): Promise<{ url: string; port: number }> {
    if (runtime.started) return { url: runtime.url, port: runtime.port };
    const info = await assertStartup(chain, cfg);
    runtime.tokens = info.tokens;
    await listen(server, cfg.port, cfg.host);
    const addr = server.address() as AddressInfo;
    const hostForUrl = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
    runtime.port = addr.port;
    runtime.url = `http://${hostForUrl}:${addr.port}`;
    runtime.started = true;
    cfg.log(
      `facilitator: ${chain.account.address} listening on ${runtime.url} (${cfg.network}, ` +
        `tokens ${info.tokens.map((t) => `${t.symbol}@${t.address}`).join(', ')}, ` +
        `payees ${cfg.payees ? cfg.payees.join(', ') : 'ANY'}, receipt timeout ${cfg.receiptTimeoutMs} ms)`,
    );
    if (!cfg.payees) cfg.log('facilitator: no PAYEES allowlist - anyone can have this account pay gas to settle to any address');
    return { url: runtime.url, port: runtime.port };
  }

  async function stop(): Promise<void> {
    if (!runtime.started) return;
    runtime.started = false;
    await close(server);
    cfg.log(`facilitator: stopped ${runtime.url}`);
  }

  return {
    address: chain.account.address,
    get url() {
      return runtime.url;
    },
    facilitator,
    start,
    stop,
  };
}
