import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // All suites share one hardhat node (port 8547) and one SP signing account:
    // run files sequentially so account nonces and balances never race.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
