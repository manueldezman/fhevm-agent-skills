// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  ConfidentialVault — Iteration 1
 * @notice Verified against @fhevm/solidity v0.11 and docs.zama.org (May 2026)
 *
 * API (v0.11):
 *   externalEuint64          — type for user-supplied encrypted inputs (was: einput)
 *   FHE.fromExternal(h, p)   — validate proof + unwrap (was: FHE.asEuint64(h, p))
 *   FHE.asEuint64(literal)   — trivial ciphertext from plaintext (only for known values like 0)
 *   FHE.allow(handle, addr)  — grant ACL permission
 *   FHE.allowThis(handle)    — grant ACL to address(this)
 *   FHE.isSenderAllowed(h)   — returns bool, reverts if false when used in require()
 *   FHE.isInitialized(h)     — returns bool, checks if handle != bytes32(0)
 *   FHE.select(cond, a, b)   — branch-free conditional (FHE if-else)
 *   FHE.ge(a, b)             — returns ebool (encrypted bool — NOT a Solidity bool)
 *   FHE.sub(a, b)            — wraps on underflow, always guard with ge + select
 *
 * CONSTRUCTOR NOTE:
 *   Do NOT call FHE.asEuint64(0) in the constructor — it reverts in v0.11.
 *   Use lazy initialization with FHE.isInitialized() instead.
 */
contract ConfidentialVault is ZamaEthereumConfig {

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => euint64) private _balances;
    euint64 private _totalDeposited;
    mapping(address => bool) private _hasDeposited;
    address public immutable owner;

    // ── Events (no encrypted payloads — amounts leak info) ────────────────────

    event Deposited(address indexed user);
    event WithdrawAttempted(address indexed user);

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyOwner();
    error NoBalance();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        // Do NOT initialize encrypted state here in v0.11 — use lazy init in deposit()
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        // 1. Validate proof and unwrap — proof is bound to (this contract, msg.sender)
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // 2. Lazy init — cannot call FHE.asEuint64(0) in constructor in v0.11
        if (!_hasDeposited[msg.sender]) {
            _balances[msg.sender] = FHE.asEuint64(0);
            FHE.allowThis(_balances[msg.sender]);
            _hasDeposited[msg.sender] = true;
        }

        // 3. Compute new balance
        euint64 newBalance = FHE.add(_balances[msg.sender], amount);
        _balances[msg.sender] = newBalance;

        // 4. Re-grant ACL on the NEW handle — every FHE op produces a new handle
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        // 5. Update total (lazy init, contract-only ACL)
        if (!FHE.isInitialized(_totalDeposited)) {
            _totalDeposited = FHE.asEuint64(0);
            FHE.allowThis(_totalDeposited);
        }
        euint64 newTotal = FHE.add(_totalDeposited, amount);
        _totalDeposited = newTotal;
        FHE.allowThis(newTotal);

        emit Deposited(msg.sender);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function withdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        if (!_hasDeposited[msg.sender]) revert NoBalance();

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        // ebool is encrypted — cannot use in if/else, only in FHE.select()
        ebool hasSufficient = FHE.ge(_balances[msg.sender], amount);

        // Branch-free: both paths computed, select picks based on hasSufficient
        // FHE.sub wraps on underflow — MUST guard with ge + select
        euint64 newBalance = FHE.select(
            hasSufficient,
            FHE.sub(_balances[msg.sender], amount),
            _balances[msg.sender]
        );

        _balances[msg.sender] = newBalance;
        FHE.allowThis(newBalance);
        FHE.allow(newBalance, msg.sender);

        emit WithdrawAttempted(msg.sender);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getBalance() external view returns (euint64) {
        if (!_hasDeposited[msg.sender]) revert NoBalance();
        require(FHE.isSenderAllowed(_balances[msg.sender]), "Not allowed");
        return _balances[msg.sender];
    }

    function getBalanceOf(address user) external view returns (euint64) {
        if (!_hasDeposited[user]) revert NoBalance();
        require(FHE.isSenderAllowed(_balances[user]), "Not allowed");
        return _balances[user];
    }

    function getTotalDeposited() external view onlyOwner returns (euint64) {
        return _totalDeposited;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function grantOwnerTotalAccess() external onlyOwner {
        FHE.allow(_totalDeposited, owner);
    }
}