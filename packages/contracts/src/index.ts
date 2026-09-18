export {
  AEP2_DEBIT_WALLET_ABI,
  AEP2_DEBIT_WALLET_BYTECODE,
  MOCK_USDC_ABI,
  MOCK_USDC_BYTECODE,
} from './abi.js';
export * from './deploy.js';
export * from './deployments.js';

/** EIP-712 domain (name/version) of MockUSDC — mirrors real USDC v2. */
export const MOCK_USDC_DOMAIN = { name: 'Mock USD Coin', version: '2' } as const;

/** EIP-712 domain (name/version) of AEP2DebitWallet (see core's WALLET_DOMAIN). */
export const WALLET_DOMAIN = { name: 'AEP2DebitWallet', version: '1' } as const;

/** Mirrors the contract's SettleStatus enum (index = uint8 status). */
export const SETTLE_STATUS = [
  'ok',
  'sp_not_authorized',
  'expired',
  'nonce_used',
  'insufficient_balance',
  'invalid_signature',
  'bad_params',
] as const;
export type SettleStatusName = (typeof SETTLE_STATUS)[number];
