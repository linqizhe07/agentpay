import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // The chain suite shares one hardhat node (:8548) and one funded payer
    // account: run files sequentially so nonces never race across workers.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
