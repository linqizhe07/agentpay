/**
 * Bare Hardhat v2 config — no plugins.
 * Compilation and `hardhat node` only; tests run via vitest + viem.
 */
module.exports = {
  defaultNetwork: 'hardhat',
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.x uses the mcopy opcode; 0.8.24 defaults to shanghai.
      // Base (mainnet and Sepolia) is Cancun-capable.
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
  },
};
