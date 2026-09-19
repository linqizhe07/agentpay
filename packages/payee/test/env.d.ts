declare module 'vitest' {
  export interface ProvidedContext {
    /** Empty string when the hardhat fixture is ready; else the reason chain tests skip. */
    skipReason: string;
    usdc: `0x${string}`;
    rpcUrl: string;
  }
}

export {};
