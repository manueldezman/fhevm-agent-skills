/**
 * ConfidentialDarkPool.test.ts — Iteration 3
 *
 * NEW PATTERNS vs previous iterations:
 *   1. Multiple encrypted inputs (amount + direction) sharing one proof
 *      fhevm.createEncryptedInput().add64(n).add8(m).encrypt()
 *      handles[0] = amount, handles[1] = direction
 *
 *   2. externalEuint8 — encrypted uint8 for direction encoding
 *
 *   3. FHE.min() for encrypted fill amount computation
 *
 *   4. publicDecryptEuint() on settled fill amounts
 *
 *   5. ERC-20 deposit/withdraw flow alongside encrypted orders
 *
 *   6. Order matching without revealing amounts to matcher
 */

import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("ConfidentialDarkPool — Iteration 3", function () {

  let pool: any;
  let poolAddress: string;
  let tokenA: any;
  let tokenB: any;
  let tokenAAddress: string;
  let tokenBAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  const DEPOSIT_AMOUNT = ethers.parseUnits("10000", 18);
  const ORDER_AMOUNT   = 1000n;

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();

    tokenA = await ethers.deployContract("MockERC20", ["Token A", "TKNA"]);
    tokenB = await ethers.deployContract("MockERC20", ["Token B", "TKNB"]);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();
    tokenAAddress = await tokenA.getAddress();
    tokenBAddress = await tokenB.getAddress();

    pool = await ethers.deployContract("ConfidentialDarkPool");
    await pool.waitForDeployment();
    poolAddress = await pool.getAddress();

    // Mint large supply to all traders
    const LARGE = ethers.parseUnits("1000000", 18);
    await tokenA.mint(alice.address, LARGE);
    await tokenA.mint(bob.address, LARGE);
    await tokenB.mint(alice.address, LARGE);
    await tokenB.mint(bob.address, LARGE);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function encryptOrder(amount: bigint, direction: number, trader: HardhatEthersSigner) {
    return fhevm
      .createEncryptedInput(poolAddress, trader.address)
      .add64(amount)
      .add8(direction)
      .encrypt();
  }

  // Approve fresh before every deposit — avoids allowance exhaustion across tests
  async function depositAndOrder(
    trader: HardhatEthersSigner,
    tokenIn: any,
    tokenInAddress: string,
    tokenOutAddress: string,
    amount: bigint,
    direction: number
  ): Promise<number> {
    // Fresh approval each time
    await (await tokenIn.connect(trader).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
    await (await pool.connect(trader).deposit(tokenInAddress, DEPOSIT_AMOUNT)).wait();

    const enc = await encryptOrder(amount, direction, trader);
    const tx = await pool.connect(trader).submitOrder(
      tokenInAddress,
      tokenOutAddress,
      enc.handles[0],
      enc.handles[1],
      enc.inputProof
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderSubmitted");
    return Number(event.args.orderId);
  }

  async function decryptFillAmount(orderId: number): Promise<bigint> {
    const handle = await pool.getSettledAmount(orderId);
    return fhevm.publicDecryptEuint(FhevmType.euint64, handle, poolAddress);
  }

  async function decryptOrderAmount(orderId: number, trader: HardhatEthersSigner): Promise<bigint> {
    const handle = await pool.connect(trader).getOrderAmount(orderId);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, trader);
  }

  // ── 1. Deployment ──────────────────────────────────────────────────────────

  describe("1. Deployment", function () {

    it("owner is set correctly", async function () {
      expect(await pool.owner()).to.equal(owner.address);
    });

    it("token addresses are valid", async function () {
      expect(tokenAAddress).to.not.equal(ethers.ZeroAddress);
      expect(tokenBAddress).to.not.equal(ethers.ZeroAddress);
    });

  });

  // ── 2. Deposit ─────────────────────────────────────────────────────────────

  describe("2. Deposit", function () {

    it("trader can deposit ERC-20 tokens", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await (await tokenA.connect(alice).approve(poolAddress, amount)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, amount)).wait();
      expect(await pool.getDeposit(alice.address, tokenAAddress)).to.equal(amount);
    });

    it("deposit emits Deposited event", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await (await tokenA.connect(alice).approve(poolAddress, amount)).wait();
      await expect(pool.connect(alice).deposit(tokenAAddress, amount))
        .to.emit(pool, "Deposited")
        .withArgs(alice.address, tokenAAddress, amount);
    });

    it("trader can withdraw deposited tokens", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await (await tokenA.connect(alice).approve(poolAddress, amount)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, amount)).wait();
      const balanceBefore = await tokenA.balanceOf(alice.address);
      await (await pool.connect(alice).withdraw(tokenAAddress, amount)).wait();
      const balanceAfter = await tokenA.balanceOf(alice.address);
      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("cannot withdraw more than deposited", async function () {
      const amount = ethers.parseUnits("1000", 18);
      await (await tokenA.connect(alice).approve(poolAddress, amount)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, amount)).wait();
      await expect(
        pool.connect(alice).withdraw(tokenAAddress, amount + 1n)
      ).to.be.revertedWith("Insufficient");
    });

  });

  // ── 3. Order submission ────────────────────────────────────────────────────

  describe("3. Order submission", function () {

    it("[PATTERN] submit order with two encrypted values sharing one proof", async function () {
      await (await tokenA.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, DEPOSIT_AMOUNT)).wait();

      const enc = await fhevm
        .createEncryptedInput(poolAddress, alice.address)
        .add64(ORDER_AMOUNT)
        .add8(1)
        .encrypt();

      const tx = await pool.connect(alice).submitOrder(
        tokenAAddress, tokenBAddress,
        enc.handles[0], enc.handles[1], enc.inputProof
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderSubmitted");
      expect(event).to.not.be.undefined;
      expect(event.args.trader).to.equal(alice.address);
    });

    it("OrderSubmitted event contains no amount info", async function () {
      await (await tokenA.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, DEPOSIT_AMOUNT)).wait();
      const enc = await encryptOrder(ORDER_AMOUNT, 1, alice);
      const tx = await pool.connect(alice).submitOrder(
        tokenAAddress, tokenBAddress,
        enc.handles[0], enc.handles[1], enc.inputProof
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderSubmitted");
      expect(event.args.length).to.equal(4);
    });

    it("trader can read their own encrypted order amount", async function () {
      const orderId = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 1
      );
      expect(await decryptOrderAmount(orderId, alice)).to.equal(ORDER_AMOUNT);
    });

    it("[ACL] attacker cannot read alice's order amount", async function () {
      const orderId = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 1
      );
      await expect(
        pool.connect(attacker).getOrderAmount(orderId)
      ).to.be.revertedWith("Not allowed");
    });

    it("[ANTI-PATTERN] proof cannot be reused by different trader", async function () {
      await (await tokenA.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, DEPOSIT_AMOUNT)).wait();
      const enc = await encryptOrder(ORDER_AMOUNT, 1, alice);
      await expect(
        pool.connect(bob).submitOrder(
          tokenAAddress, tokenBAddress,
          enc.handles[0], enc.handles[1], enc.inputProof
        )
      ).to.be.reverted;
    });

    it("cannot submit order with same token pair", async function () {
      await (await tokenA.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, DEPOSIT_AMOUNT)).wait();
      const enc = await encryptOrder(ORDER_AMOUNT, 1, alice);
      await expect(
        pool.connect(alice).submitOrder(
          tokenAAddress, tokenAAddress,
          enc.handles[0], enc.handles[1], enc.inputProof
        )
      ).to.be.revertedWith("Same token");
    });

  });

  // ── 4. Order matching ──────────────────────────────────────────────────────

  describe("4. Order matching", function () {

    it("[PATTERN] owner matches two compatible orders", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await (await pool.connect(owner).matchOrders(orderIdA, orderIdB)).wait();
      const [, , , statusA] = await pool.getOrderInfo(orderIdA);
      const [, , , statusB] = await pool.getOrderInfo(orderIdB);
      expect(statusA).to.equal(1);
      expect(statusB).to.equal(1);
    });

    it("OrderMatched event reveals counterparties but not amounts", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await expect(pool.connect(owner).matchOrders(orderIdA, orderIdB))
        .to.emit(pool, "OrderMatched")
        .withArgs(orderIdA, orderIdB, alice.address, bob.address);
    });

    it("[PATTERN] fill amount publicly decryptable after match", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await (await pool.connect(owner).matchOrders(orderIdA, orderIdB)).wait();
      const fillA = await decryptFillAmount(orderIdA);
      const fillB = await decryptFillAmount(orderIdB);
      expect(fillA).to.equal(ORDER_AMOUNT);
      expect(fillB).to.equal(ORDER_AMOUNT);
    });

    it("[PATTERN] partial fill — smaller order determines fill amount", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, 2000n, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, 500n, 1
      );
      await (await pool.connect(owner).matchOrders(orderIdA, orderIdB)).wait();
      expect(await decryptFillAmount(orderIdA)).to.equal(500n);
      expect(await decryptFillAmount(orderIdB)).to.equal(500n);
    });

    it("cannot match incompatible token pairs", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      await expect(
        pool.connect(owner).matchOrders(orderIdA, orderIdB)
      ).to.be.revertedWithCustomError(pool, "IncompatiblePair");
    });

    it("cannot match same trader orders", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      await (await tokenB.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenBAddress, DEPOSIT_AMOUNT)).wait();
      const enc = await encryptOrder(ORDER_AMOUNT, 1, alice);
      const tx = await pool.connect(alice).submitOrder(
        tokenBAddress, tokenAAddress,
        enc.handles[0], enc.handles[1], enc.inputProof
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderSubmitted");
      const orderIdB = Number(event.args.orderId);
      await expect(
        pool.connect(owner).matchOrders(orderIdA, orderIdB)
      ).to.be.revertedWithCustomError(pool, "InvalidOrder");
    });

    it("non-owner cannot match orders", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await expect(
        pool.connect(attacker).matchOrders(orderIdA, orderIdB)
      ).to.be.revertedWithCustomError(pool, "OnlyOwner");
    });

    it("cannot match already matched order", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await (await pool.connect(owner).matchOrders(orderIdA, orderIdB)).wait();
      const orderIdC = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await expect(
        pool.connect(owner).matchOrders(orderIdA, orderIdC)
      ).to.be.revertedWithCustomError(pool, "AlreadySettled");
    });

  });

  // ── 5. Cancel order ────────────────────────────────────────────────────────

  describe("5. Cancel order", function () {

    it("trader can cancel their own pending order", async function () {
      const orderId = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      await (await pool.connect(alice).cancelOrder(orderId)).wait();
      const [, , , status] = await pool.getOrderInfo(orderId);
      expect(status).to.equal(2);
    });

    it("attacker cannot cancel alice's order", async function () {
      const orderId = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      await expect(
        pool.connect(attacker).cancelOrder(orderId)
      ).to.be.revertedWithCustomError(pool, "OnlyTrader");
    });

    it("cannot cancel already matched order", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      await (await pool.connect(owner).matchOrders(orderIdA, orderIdB)).wait();
      await expect(
        pool.connect(alice).cancelOrder(orderIdA)
      ).to.be.revertedWithCustomError(pool, "AlreadySettled");
    });

  });

  // ── 6. Privacy guarantees ──────────────────────────────────────────────────

  describe("6. Privacy guarantees — MEV protection", function () {

    it("[MEV] order amount not visible in events", async function () {
      await (await tokenA.connect(alice).approve(poolAddress, DEPOSIT_AMOUNT)).wait();
      await (await pool.connect(alice).deposit(tokenAAddress, DEPOSIT_AMOUNT)).wait();
      const enc = await encryptOrder(9999n, 1, alice);
      const tx = await pool.connect(alice).submitOrder(
        tokenAAddress, tokenBAddress,
        enc.handles[0], enc.handles[1], enc.inputProof
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderSubmitted");
      expect(event.args.orderId).to.not.be.undefined;
      expect(event.args.trader).to.equal(alice.address);
    });

    it("[MEV] match event reveals counterparties but not fill amount", async function () {
      const orderIdA = await depositAndOrder(
        alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0
      );
      const orderIdB = await depositAndOrder(
        bob, tokenB, tokenBAddress, tokenAAddress, ORDER_AMOUNT, 1
      );
      const tx = await pool.connect(owner).matchOrders(orderIdA, orderIdB);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "OrderMatched");
      expect(event.args.counterpartyA).to.equal(alice.address);
      expect(event.args.counterpartyB).to.equal(bob.address);
    });

    it("[PRIVACY] trader can view their own order history", async function () {
      await depositAndOrder(alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0);
      await depositAndOrder(alice, tokenA, tokenAAddress, tokenBAddress, ORDER_AMOUNT, 0);
      const aliceOrders = await pool.getTraderOrders(alice.address);
      expect(aliceOrders.length).to.equal(2);
    });

  });

});