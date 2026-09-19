import { parseAbi } from 'viem';

/**
 * The slice of an EIP-3009 token (Circle's FiatTokenV2_2, MockUSDC) the payer
 * side reads: balances, the nonce state that says whether an authorization
 * was settled, and the events that name the settling transaction.
 */
export const EIP3009_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
