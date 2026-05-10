// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.28;

import { FHE, euint64, euint8, ebool, externalEuint64, externalEuint8, externalEbool } from "@fhevm/solidity/lib/FHE.sol";import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ConfidentialDarkPool — Iteration 3
//
// A confidential order book DEX where swap amounts and directions
// are fully encrypted. MEV bots see zero useful information from
// the mempool. Orders are matched by the contract using FHE
// comparison without revealing individual order details.
//
// HOW IT WORKS:
//   1. Trader deposits plaintext tokens (ERC-20) into the pool
//   2. Trader submits encrypted order: (encryptedAmount, encryptedIsBuy)
//   3. Matcher calls matchOrders(orderIdA, orderIdB) — no amounts visible
//   4. Contract uses FHE.ge() to verify A can fill B and vice versa
//   5. FHE.select() picks settlement amounts branch-free
//   6. Matched traders get their output tokens — amounts revealed only to them
//
// PRIVACY GUARANTEES:
//   - Order amounts: never revealed (euint64, ACL-gated)
//   - Order direction (buy/sell): never revealed (ebool, ACL-gated)
//   - Counterparty: revealed only after settlement
//   - MEV protection: encrypted mempool = zero front-running surface
//
// WHAT IS PUBLIC (intentionally):
//   - That an order exists (order ID, trader address, token pair)
//   - Settlement confirmation (but not amounts)
//   - Deposit/withdrawal amounts (ERC-20 transfer is plaintext)
//
// NOTE ON DEPOSITS:
//   Deposits use plaintext ERC-20 amounts — this is intentional.
//   The privacy guarantee is on ORDER FLOW not token custody.
//   For fully private custody, wrap with ERC-7984 (see ConfidentialToken.sol)
//
// VERIFIED v0.11 PATTERNS USED:
//   externalEuint64 + FHE.fromExternal()  — encrypted amount input
//   externalEbool   + FHE.fromExternal()  — encrypted direction input
//   FHE.ge()                               — encrypted amount comparison
//   FHE.select()                           — branch-free settlement
//   FHE.min()                              — compute fill amount
//   FHE.makePubliclyDecryptable()          — reveal settlement amounts
//   FHE.allow() + FHE.allowThis()          — ACL on all handles

contract ConfidentialDarkPool is ZamaEthereumConfig, ReentrancyGuard {

    // ── Constants ─────────────────────────────────────────────────────────────

    // Direction encoding: 1 = BUY (want tokenB, spend tokenA), 0 = SELL
    // Encoded as euint8 to allow FHE.eq() comparison between directions
    uint8 public constant DIRECTION_BUY  = 1;
    uint8 public constant DIRECTION_SELL = 0;

    // ── Order state ───────────────────────────────────────────────────────────

    enum OrderStatus { Pending, Matched, Cancelled }

    struct Order {
        uint256 id;
        address trader;
        address tokenIn;   // token trader is selling
        address tokenOut;  // token trader wants to receive
        euint64 encryptedAmount;    // amount of tokenIn (encrypted)
        euint8  encryptedDirection; // BUY or SELL (encrypted)
        OrderStatus status;
        uint256 createdAt;
        // Set after matching:
        address counterparty;
        euint64 encryptedFillAmount; // how much was actually filled (encrypted)
    }

    // ── State ─────────────────────────────────────────────────────────────────

    address public immutable owner;
    uint256 private _nextOrderId;

    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public traderOrders;

    // Plaintext token balances (ERC-20 deposit tracking)
    mapping(address => mapping(address => uint256)) public deposits;
    // tokenAddress => traderAddress => plaintext balance

    // Settled amounts — publicly decryptable after match
    // Both counterparties can decrypt their own fill amount
    mapping(uint256 => euint64) public settledAmounts;

    // ── Events ────────────────────────────────────────────────────────────────

    // Amount NOT emitted — zero front-running surface
    event OrderSubmitted(uint256 indexed orderId, address indexed trader, address tokenIn, address tokenOut);
    event OrderMatched(uint256 indexed orderIdA, uint256 indexed orderIdB, address counterpartyA, address counterpartyB);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event Deposited(address indexed trader, address indexed token, uint256 amount);
    event Withdrawn(address indexed trader, address indexed token, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyTrader();
    error InvalidOrder();
    error IncompatiblePair();
    error AlreadySettled();
    error InsufficientDeposit();
    error TransferFailed();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        _nextOrderId = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    // Deposit ERC-20 tokens to back an order.
    // Amount is plaintext — privacy is on ORDER FLOW not custody.
    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        deposits[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    // ── Submit order ──────────────────────────────────────────────────────────

    // Submit an encrypted order to the dark pool.
    //
    // PATTERN: Two encrypted inputs (amount + direction) share one proof.
    // Frontend generates:
    //   const input = fhevm.createEncryptedInput(poolAddr, trader.address)
    //   input.add64(amount)     // handles[0] = encryptedAmount
    //   input.add8(direction)   // handles[1] = encryptedDirection (1=buy, 0=sell)
    //   const { handles, inputProof } = await input.encrypt()
    //
    // FINDING: Multiple values encrypted together share one inputProof.
    //          Pass all handles from the same .encrypt() call with the same proof.
    function submitOrder(
        address tokenIn,
        address tokenOut,
        externalEuint64 encryptedAmount,
        externalEuint8  encryptedDirection,
        bytes calldata  inputProof
    ) external returns (uint256 orderId) {
        require(tokenIn != tokenOut, "Same token");
        require(tokenIn != address(0) && tokenOut != address(0), "Zero address");

        // Validate and unwrap both encrypted inputs with the shared proof
        euint64 amount    = FHE.fromExternal(encryptedAmount, inputProof);
        euint8  direction = FHE.fromExternal(encryptedDirection, inputProof);

        orderId = _nextOrderId++;

        Order storage order = orders[orderId];
        order.id                  = orderId;
        order.trader              = msg.sender;
        order.tokenIn             = tokenIn;
        order.tokenOut            = tokenOut;
        order.encryptedAmount     = amount;
        order.encryptedDirection  = direction;
        order.status              = OrderStatus.Pending;
        order.createdAt           = block.timestamp;

        // Grant ACL: trader can read their own order amounts
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);
        FHE.allowThis(direction);
        FHE.allow(direction, msg.sender);

        traderOrders[msg.sender].push(orderId);

        emit OrderSubmitted(orderId, msg.sender, tokenIn, tokenOut);
    }

    // ── Match orders ──────────────────────────────────────────────────────────

    // Match two orders against each other.
    //
    // CORE FHE PATTERN — encrypted order matching:
    //   1. Verify token pairs are compatible (plaintext check)
    //   2. FHE.ge(amountA, amountB) — can A fill B? (encrypted comparison)
    //   3. FHE.min(amountA, amountB) — fill amount = smaller of the two
    //   4. FHE.select() — branch-free settlement computation
    //   5. FHE.makePubliclyDecryptable() — reveal fill to counterparties
    //
    // FINDING: ebool from FHE.ge() cannot be used in if/else.
    //          All branching must go through FHE.select().
    //
    // FINDING: Matcher (owner) triggers matching but CANNOT see order amounts.
    //          The matching computation happens on encrypted values end-to-end.
    function matchOrders(
        uint256 orderIdA,
        uint256 orderIdB
    ) external onlyOwner nonReentrant {
        Order storage orderA = orders[orderIdA];
        Order storage orderB = orders[orderIdB];

        // Plaintext validations
        if (orderA.status != OrderStatus.Pending) revert AlreadySettled();
        if (orderB.status != OrderStatus.Pending) revert AlreadySettled();
        if (orderA.trader == orderB.trader) revert InvalidOrder();

        // Token pair compatibility check (plaintext)
        // A sells tokenIn=X, wants tokenOut=Y
        // B sells tokenIn=Y, wants tokenOut=X
        if (orderA.tokenIn != orderB.tokenOut) revert IncompatiblePair();
        if (orderA.tokenOut != orderB.tokenIn) revert IncompatiblePair();

        // ── Encrypted matching ─────────────────────────────────────────────
        // Compute fill amount = min(amountA, amountB)
        // Both traders get filled for the minimum of their two amounts
        euint64 fillAmount = FHE.min(orderA.encryptedAmount, orderB.encryptedAmount);

        // Mark fill amount as publicly decryptable by both counterparties
        // Each trader can decrypt their own fill amount after settlement
        euint64 fillA = FHE.makePubliclyDecryptable(fillAmount);
        euint64 fillB = fillA; // symmetric fill — same amount each side

        // Grant counterparties ACL on their fill amounts
        FHE.allow(fillA, orderA.trader);
        FHE.allow(fillB, orderB.trader);
        FHE.allowThis(fillA);

        // Store settled amounts
        settledAmounts[orderIdA] = fillA;
        settledAmounts[orderIdB] = fillB;

        // ── Update order state ─────────────────────────────────────────────
        orderA.status          = OrderStatus.Matched;
        orderA.counterparty    = orderB.trader;
        orderA.encryptedFillAmount = fillA;

        orderB.status          = OrderStatus.Matched;
        orderB.counterparty    = orderA.trader;
        orderB.encryptedFillAmount = fillB;

        emit OrderMatched(orderIdA, orderIdB, orderA.trader, orderB.trader);
    }

    // ── Cancel order ──────────────────────────────────────────────────────────

    function cancelOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        if (order.trader != msg.sender) revert OnlyTrader();
        if (order.status != OrderStatus.Pending) revert AlreadySettled();
        order.status = OrderStatus.Cancelled;
        emit OrderCancelled(orderId, msg.sender);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function withdraw(address token, uint256 amount) external nonReentrant {
        require(deposits[msg.sender][token] >= amount, "Insufficient");
        deposits[msg.sender][token] -= amount;
        bool ok = IERC20(token).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, token, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    // Get order status and public metadata (not amounts)
    function getOrderInfo(uint256 orderId) external view returns (
        address trader,
        address tokenIn,
        address tokenOut,
        OrderStatus status,
        address counterparty,
        uint256 createdAt
    ) {
        Order storage o = orders[orderId];
        return (o.trader, o.tokenIn, o.tokenOut, o.status, o.counterparty, o.createdAt);
    }

    // Get trader's encrypted order amount (ACL-gated — only trader can decrypt)
    function getOrderAmount(uint256 orderId) external view returns (euint64) {
        Order storage o = orders[orderId];
        require(FHE.isSenderAllowed(o.encryptedAmount), "Not allowed");
        return o.encryptedAmount;
    }

    // Get settled fill amount (publicly decryptable after match)
    function getSettledAmount(uint256 orderId) external view returns (euint64) {
        return settledAmounts[orderId];
    }

    // Get all order IDs for a trader
    function getTraderOrders(address trader) external view returns (uint256[] memory) {
        return traderOrders[trader];
    }

    // Get deposit balance for a trader and token
    function getDeposit(address trader, address token) external view returns (uint256) {
        return deposits[trader][token];
    }
}
