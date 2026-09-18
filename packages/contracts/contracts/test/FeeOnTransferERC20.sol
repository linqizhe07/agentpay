// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title FeeOnTransferERC20
 * @notice Test-only ERC20 that burns `feeBps` of every transfer before it reaches
 *         the recipient, so a deposit delivers less than it asked for (10_000 bps
 *         delivers nothing while transferFrom still succeeds). The contract tests
 *         deploy it straight from its Hardhat artifact; it is deliberately absent
 *         from scripts/gen-abi.mjs and never shipped in src/abi.ts.
 */
contract FeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;

    error FeeTooHigh();

    constructor(uint256 feeBps_) ERC20("Fee Token", "FEE") {
        if (feeBps_ > 10_000) revert FeeTooHigh();
        feeBps = feeBps_;
    }

    /// @notice Open mint — test token only. Minting is not taxed.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = (from == address(0) || to == address(0)) ? 0 : (value * feeBps) / 10_000;
        if (fee != 0) super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
