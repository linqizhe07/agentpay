import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Spawns a hardhat node on :8549 and deploys the fixture for chain.test.ts;
    // a no-op when AGENTPAY_SKIP_CHAIN_TESTS=1 (the offline suite needs no chain).
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
