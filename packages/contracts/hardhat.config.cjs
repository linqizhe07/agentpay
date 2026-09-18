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
      // authorize() carries the full EIP-3009 arg surface (13 args) — needs IR
      // codegen to avoid stack-too-deep.
      viaIR: true,
      // OpenZeppelin 5.x uses the mcopy opcode; 0.8.24 defaults to shanghai.
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
  },
};
