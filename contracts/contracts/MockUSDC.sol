// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockUSDC
 * @notice Test-only ERC20 ("Mock USD Coin", "USDC", 6 decimals) implementing the
 *         EIP-3009 subset used by x402, mirroring real USDC v2:
 *         transferWithAuthorization / receiveWithAuthorization / authorizationState.
 *         EIP-712 domain: name "Mock USD Coin", version "2".
 *         `mint` is open — DO NOT deploy outside local test chains.
 */
contract MockUSDC is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error CallerMustBePayee();

    constructor() ERC20("Mock USD Coin", "USDC") EIP712("Mock USD Coin", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open mint — test token only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice True iff `nonce` has already been used by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice EIP-3009: execute a transfer with a signed authorization.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    /**
     * @notice EIP-3009: receive a transfer with a signed authorization from the payer.
     *         Additionally requires the caller to be the payee (`to == msg.sender`),
     *         which lets contracts pull funds and attribute deposits atomically.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _useAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != from) revert InvalidSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
