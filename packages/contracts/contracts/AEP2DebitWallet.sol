// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AEP2DebitWallet
 * @notice Pre-funded, multi-token debit wallet for the Agent Embedded Payment
 *         Protocol: "authorize first, settle later".
 *
 *         A payer deposits stablecoins, authorizes one or more Settlement
 *         Processors (SPs) for its own account, and signs one-time EIP-712
 *         Mandates off-chain. An authorized SP later debits the payer's balance
 *         with `settle` / `settleBatch` and pays the payee directly.
 *
 *         Withdrawals are delayed by `withdrawDelay` so in-flight mandates can
 *         still be settled; `settle` debits the full balance (including funds
 *         parked in a pending withdrawal), and `executeWithdraw` pays out only
 *         what is left. `debitableBalance` (balance minus pending withdrawal)
 *         is the admission figure SPs use for NEW mandates, so a mandate is
 *         never accepted against money already on its way out.
 *
 *         Revoking an SP is delayed the same way: `revokeSP` schedules the
 *         revocation `withdrawDelay` seconds out, so every mandate the SP
 *         receipted before the call (all due within its settle window, which
 *         is <= withdrawDelay) can still be settled. Otherwise a payer could
 *         take delivery and revoke in the next block.
 *
 *         mandateDigest byte-matches the core package's mandateDigest().
 */
contract AEP2DebitWallet is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Mandate {
        address owner;
        address token;
        address payee;
        uint256 amount;
        uint256 nonce;
        uint64 deadline;
        bytes32 ref;
    }

    struct Withdrawal {
        uint256 amount;
        uint64 unlockAt;
    }

    /// @dev One slot. `revokeAt == 0` means no revocation is scheduled.
    struct Authorization {
        bool enabled;
        uint64 revokeAt;
    }

    /// @dev Per-item outcome of `_settle`; `settleBatch` reports these instead of reverting.
    enum SettleStatus {
        Ok,
        SPNotAuthorized,
        Expired,
        NonceUsed,
        InsufficientBalance,
        BadSignature,
        BadParams
    }

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address owner,address token,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 ref)"
    );

    /// @notice Seconds between requestWithdraw and executeWithdraw. Must be >= every SP's settlement window.
    uint64 public immutable withdrawDelay;

    /// @notice payer => token => total custody (includes funds in a pending withdrawal).
    mapping(address => mapping(address => uint256)) public balances;
    /// @notice payer => token => pending withdrawal.
    mapping(address => mapping(address => Withdrawal)) public withdrawals;
    /// @notice payer => nonce => consumed. Nonces are payer-chosen random uint256s.
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    /// @dev payer => settlement processor => authorization; read through `authorizedSP` / `authorizationOf`.
    mapping(address => mapping(address => Authorization)) private _authorizations;

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    /// @dev Emitted with `enabled = true` by `authorizeSP` and `cancelRevoke`; revocations emit `SPRevocationScheduled`.
    event SPAuthorized(address indexed owner, address indexed sp, bool enabled);
    event SPRevocationScheduled(address indexed owner, address indexed sp, uint64 revokeAt);
    event WithdrawalRequested(address indexed owner, address indexed token, uint256 amount, uint64 unlockAt);
    event WithdrawalCancelled(address indexed owner, address indexed token, uint256 amount);
    event WithdrawalExecuted(address indexed owner, address indexed token, address to, uint256 amount);
    event Settled(
        address indexed owner,
        address indexed token,
        address indexed payee,
        uint256 amount,
        uint256 nonce,
        bytes32 ref,
        bytes32 mandateDigest
    );
    event SettleSkipped(bytes32 indexed mandateDigest, address indexed owner, uint256 nonce, uint8 status);

    error BadParams();
    error SPNotAuthorized();
    error Expired();
    error NonceUsed();
    error InsufficientBalance();
    error BadSignature();
    error WithdrawalPending();
    error NoWithdrawal();
    error WithdrawalLocked(uint64 unlockAt);
    error LengthMismatch();

    constructor(uint64 withdrawDelay_) EIP712("AEP2DebitWallet", "1") {
        if (withdrawDelay_ == 0) revert BadParams();
        withdrawDelay = withdrawDelay_;
    }

    // ------------------------------------------------------------ payer side

    /// @notice Pre-fund the wallet. Caller must have approved this contract for `amount`.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (token == address(0) || amount == 0) revert BadParams();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Allow a settlement processor to debit the caller's balance with valid mandates. Clears any scheduled revocation.
    function authorizeSP(address sp) external {
        if (sp == address(0)) revert BadParams();
        _authorizations[msg.sender][sp] = Authorization({enabled: true, revokeAt: 0});
        emit SPAuthorized(msg.sender, sp, true);
    }

    /**
     * @notice Schedule the revocation of a settlement processor: it may still settle
     *         until `block.timestamp + withdrawDelay`, which covers every mandate it
     *         receipted before this call. Idempotent: an already scheduled revocation
     *         keeps its date (a repeat call can never move it earlier).
     */
    function revokeSP(address sp) external {
        Authorization storage a = _authorizations[msg.sender][sp];
        if (!a.enabled) revert BadParams();
        if (a.revokeAt != 0) return;
        uint64 revokeAt = uint64(block.timestamp) + withdrawDelay;
        a.revokeAt = revokeAt;
        emit SPRevocationScheduled(msg.sender, sp, revokeAt);
    }

    /// @notice Cancel a revocation that has not taken effect yet (afterwards, use `authorizeSP` to re-enable).
    function cancelRevoke(address sp) external {
        Authorization storage a = _authorizations[msg.sender][sp];
        if (!a.enabled || a.revokeAt == 0 || block.timestamp >= a.revokeAt) revert BadParams();
        a.revokeAt = 0;
        emit SPAuthorized(msg.sender, sp, true);
    }

    /// @notice Start the withdrawal timer. Only one pending withdrawal per (payer, token); cancel to change it.
    function requestWithdraw(address token, uint256 amount) external {
        if (amount == 0) revert BadParams();
        Withdrawal storage w = withdrawals[msg.sender][token];
        if (w.amount != 0) revert WithdrawalPending();
        if (amount > balances[msg.sender][token]) revert InsufficientBalance();
        uint64 unlockAt = uint64(block.timestamp) + withdrawDelay;
        w.amount = amount;
        w.unlockAt = unlockAt;
        emit WithdrawalRequested(msg.sender, token, amount, unlockAt);
    }

    /// @notice Cancel a pending withdrawal (only ever increases the debitable balance).
    function cancelWithdraw(address token) external {
        Withdrawal memory w = withdrawals[msg.sender][token];
        if (w.amount == 0) revert NoWithdrawal();
        delete withdrawals[msg.sender][token];
        emit WithdrawalCancelled(msg.sender, token, w.amount);
    }

    /**
     * @notice Pay out a matured withdrawal. Settlements executed during the delay
     *         take priority: the payout is min(requested, remaining balance).
     */
    function executeWithdraw(address token, address to) external nonReentrant {
        if (to == address(0)) revert BadParams();
        Withdrawal memory w = withdrawals[msg.sender][token];
        if (w.amount == 0) revert NoWithdrawal();
        if (block.timestamp < w.unlockAt) revert WithdrawalLocked(w.unlockAt);
        uint256 bal = balances[msg.sender][token];
        uint256 amt = w.amount < bal ? w.amount : bal;
        delete withdrawals[msg.sender][token];
        balances[msg.sender][token] = bal - amt;
        emit WithdrawalExecuted(msg.sender, token, to, amt);
        if (amt > 0) IERC20(token).safeTransfer(to, amt);
    }

    // ------------------------------------------------------------ views

    /// @notice Balance not earmarked by a pending withdrawal: what SPs may admit NEW mandates against.
    function debitableBalance(address owner, address token) public view returns (uint256) {
        uint256 bal = balances[owner][token];
        uint256 locked = withdrawals[owner][token].amount;
        return bal > locked ? bal - locked : 0;
    }

    /// @notice Whether `sp` may settle `owner`'s mandates right now: enabled and no revocation in effect.
    function authorizedSP(address owner, address sp) public view returns (bool) {
        Authorization storage a = _authorizations[owner][sp];
        return a.enabled && (a.revokeAt == 0 || block.timestamp < a.revokeAt);
    }

    /// @notice The raw authorization record: `revokeAt` is 0 or the unix second the SP loses the right to settle.
    function authorizationOf(address owner, address sp) external view returns (bool enabled, uint64 revokeAt) {
        Authorization storage a = _authorizations[owner][sp];
        return (a.enabled, a.revokeAt);
    }

    /// @notice EIP-712 digest of a mandate; byte-matches the core package's mandateDigest().
    function mandateDigest(Mandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(MANDATE_TYPEHASH, m.owner, m.token, m.payee, m.amount, m.nonce, m.deadline, m.ref))
        );
    }

    // ------------------------------------------------------------ settlement

    /// @notice Settle one mandate; reverts with the specific error on failure.
    function settle(Mandate calldata m, bytes calldata payerSig) external nonReentrant {
        (SettleStatus s,) = _settle(m, payerSig);
        if (s == SettleStatus.Ok) return;
        if (s == SettleStatus.SPNotAuthorized) revert SPNotAuthorized();
        if (s == SettleStatus.Expired) revert Expired();
        if (s == SettleStatus.NonceUsed) revert NonceUsed();
        if (s == SettleStatus.InsufficientBalance) revert InsufficientBalance();
        if (s == SettleStatus.BadSignature) revert BadSignature();
        revert BadParams();
    }

    /**
     * @notice Settle many mandates in one transaction (multi-payout). Items that
     *         fail validation are skipped and reported via `SettleSkipped` and the
     *         returned statuses, so one stale mandate never blocks other payees.
     *         Only a failing token transfer reverts the whole batch.
     */
    function settleBatch(Mandate[] calldata ms, bytes[] calldata sigs)
        external
        nonReentrant
        returns (uint8[] memory statuses)
    {
        if (ms.length != sigs.length) revert LengthMismatch();
        statuses = new uint8[](ms.length);
        for (uint256 i = 0; i < ms.length; i++) {
            (SettleStatus s, bytes32 digest) = _settle(ms[i], sigs[i]);
            statuses[i] = uint8(s);
            if (s != SettleStatus.Ok) emit SettleSkipped(digest, ms[i].owner, ms[i].nonce, uint8(s));
        }
    }

    /// @dev Checks (cheap storage reads first, ecrecover last), then effects, then the payout.
    function _settle(Mandate calldata m, bytes calldata payerSig) internal returns (SettleStatus, bytes32) {
        bytes32 digest = mandateDigest(m);
        if (m.owner == address(0) || m.payee == address(0) || m.amount == 0) return (SettleStatus.BadParams, digest);
        if (!authorizedSP(m.owner, msg.sender)) return (SettleStatus.SPNotAuthorized, digest);
        if (block.timestamp > m.deadline) return (SettleStatus.Expired, digest);
        if (usedNonces[m.owner][m.nonce]) return (SettleStatus.NonceUsed, digest);
        uint256 bal = balances[m.owner][m.token];
        if (bal < m.amount) return (SettleStatus.InsufficientBalance, digest);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, payerSig);
        if (err != ECDSA.RecoverError.NoError || recovered != m.owner) return (SettleStatus.BadSignature, digest);

        usedNonces[m.owner][m.nonce] = true;
        balances[m.owner][m.token] = bal - m.amount;
        emit Settled(m.owner, m.token, m.payee, m.amount, m.nonce, m.ref, digest);
        // A protocol fee (feeBps split to a collector) would be taken here, before the payout.
        IERC20(m.token).safeTransfer(m.payee, m.amount);
        return (SettleStatus.Ok, digest);
    }
}
