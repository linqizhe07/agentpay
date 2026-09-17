import type { Address } from 'viem';

declare module 'vitest' {
  export interface ProvidedContext {
    rpcUrl: string;
    chainId: number;
    usdc: Address;
    wallet: Address;
    withdrawDelay: number;
  }
}

export {};
