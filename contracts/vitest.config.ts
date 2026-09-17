import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // All suites share one hardhat node (port 8546): run files sequentially so
    // evm_increaseTime jumps and account nonces never race across workers.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
