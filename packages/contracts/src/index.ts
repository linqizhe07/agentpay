export { MOCK_USDC_ABI, MOCK_USDC_BYTECODE } from './abi.js';
export * from './deploy.js';
export * from './deployments.js';
export * from './multicall3.js';

/** EIP-712 domain (name/version) of MockUSDC — mirrors real USDC v2. */
export const MOCK_USDC_DOMAIN = { name: 'Mock USD Coin', version: '2' } as const;
