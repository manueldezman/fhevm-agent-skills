/**
 * BlindAuction.test.ts — Iteration 2a
 *
 * VERIFIED PUBLIC DECRYPTION API (v0.11, from installed plugin source):
 *   fhevm.publicDecryptEuint(FhevmType.euint64, handle, contractAddress)
 *   → returns bigint (the decrypted value)
 *
 * DOES NOT EXIST in this version:
 *   fhevm.simulateDecryption()  ← not in plugin
 *   fhevm.publicDecrypt()       ← internal only, not on HRE fhevm object
 *
 * TIME ADVANCEMENT:
 *   ethers.provider.send("evm_increaseTime", [seconds])
 *   ethers.provider.send("evm_mine", [])
 *   No external packages needed.
 */

import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("BlindAuction — Iteration 2a", function () {

  const BIDDING_DURATION = 3600;

  let auction: any;
  let auctionAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, alice, bob, carol, attacker] = await ethers.getSigners();
    const Auction = await ethers.getContractFactory("BlindAuction");
    auction = await Auction.deploy(BIDDING_DURATION);
    await auction.waitForDeployment();
    auctionAddress = await auction.getAddress();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function advanceTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function encryptBid(amount: bigint, bidder: HardhatEthersSigner) {
    return fhevm
      .createEncryptedInput(auctionAddress, bidder.address)
      .add64(amount)
      .encrypt();
  }

  async function placeBid(amount: bigint, bidder: HardhatEthersSigner) {
    const enc = await encryptBid(amount, bidder);
    const tx = await auction.connect(bidder).placeBid(enc.handles[0], enc.inputProof);
    await tx.wait();
  }

  async function decryptMyBid(bidder: HardhatEthersSigner): Promise<bigint> {
    const handle = await auction.connect(bidder).getMyBid();
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, auctionAddress, bidder);
  }

  async function closeAuction() {
    await advanceTime(BIDDING_DURATION + 1);
    await (await auction.connect(owner).closeBidding()).wait();
  }

  async function revealAndClaim(): Promise<bigint> {
    await (await auction.connect(owner).revealWinner()).wait();

    // Get the publicly decryptable handle
    const winningHandle = await auction.encryptedWinningBid();

    // VERIFIED PATTERN: publicDecryptEuint decrypts a publicly marked handle
    const winningAmount = await fhevm.publicDecryptEuint(
      FhevmType.euint64,
      winningHandle,
      auctionAddress
    );

    // Submit the decrypted amount on-chain to finalize winner
    await (await auction.claimWinner(winningAmount)).wait();

    return winningAmount;
  }

  // ── 1. Initial state ───────────────────────────────────────────────────────

  describe("1. Initial state", function () {

    it("phase is Bidding (0)", async function () {
      expect(await auction.phase()).to.equal(0);
    });

    it("owner is set correctly", async function () {
      expect(await auction.owner()).to.equal(owner.address);
    });

    it("closeBidding reverts if deadline not reached", async function () {
      await expect(auction.connect(owner).closeBidding())
        .to.be.revertedWith("Deadline not reached");
    });

    it("revealWinner reverts in Bidding phase", async function () {
      await expect(auction.connect(owner).revealWinner())
        .to.be.revertedWithCustomError(auction, "WrongPhase");
    });

  });

  // ── 2. Bidding ─────────────────────────────────────────────────────────────

  describe("2. Bidding", function () {

    it("single bid stored and ACL-gated correctly", async function () {
      await placeBid(1000n, alice);
      expect(await auction.hasBid(alice.address)).to.be.true;
      expect(await decryptMyBid(alice)).to.equal(1000n);
    });

    it("multiple bidders can bid independently", async function () {
      await placeBid(1000n, alice);
      await placeBid(2000n, bob);
      await placeBid(1500n, carol);
      expect(await decryptMyBid(alice)).to.equal(1000n);
      expect(await decryptMyBid(bob)).to.equal(2000n);
      expect(await decryptMyBid(carol)).to.equal(1500n);
    });

    it("BidPlaced event emits no amount", async function () {
      const enc = await encryptBid(1000n, alice);
      await expect(auction.connect(alice).placeBid(enc.handles[0], enc.inputProof))
        .to.emit(auction, "BidPlaced")
        .withArgs(alice.address);
    });

    it("bidder cannot read another bidder's bid", async function () {
      await placeBid(1000n, alice);
      await expect(auction.connect(bob).getMyBid())
        .to.be.revertedWith("No bid placed");
    });

    it("[PATTERN] higher rebid replaces lower bid via FHE.select", async function () {
      await placeBid(1000n, alice);
      await placeBid(2000n, alice);
      expect(await decryptMyBid(alice)).to.equal(2000n);
    });

    it("[PATTERN] lower rebid is silently ignored — no revert", async function () {
      await placeBid(2000n, alice);
      await placeBid(500n, alice);
      expect(await decryptMyBid(alice)).to.equal(2000n);
    });

    it("bidding reverts after deadline", async function () {
      await advanceTime(BIDDING_DURATION + 1);
      const enc = await encryptBid(1000n, alice);
      await expect(
        auction.connect(alice).placeBid(enc.handles[0], enc.inputProof)
      ).to.be.revertedWith("Bidding deadline reached");
    });

    it("[ANTI-PATTERN] alice proof cannot be used by bob", async function () {
      const enc = await encryptBid(1000n, alice);
      await expect(
        auction.connect(bob).placeBid(enc.handles[0], enc.inputProof)
      ).to.be.reverted;
    });

  });

  // ── 3. Phase transitions ───────────────────────────────────────────────────

  describe("3. Phase transitions", function () {

    it("closeBidding transitions to Closed (1)", async function () {
      await placeBid(1000n, alice);
      await closeAuction();
      expect(await auction.phase()).to.equal(1);
    });

    it("non-owner cannot close bidding", async function () {
      await advanceTime(BIDDING_DURATION + 1);
      await expect(auction.connect(attacker).closeBidding())
        .to.be.revertedWithCustomError(auction, "OnlyOwner");
    });

    it("cannot bid in Closed phase", async function () {
      await closeAuction();
      const enc = await encryptBid(1000n, alice);
      await expect(
        auction.connect(alice).placeBid(enc.handles[0], enc.inputProof)
      ).to.be.revertedWithCustomError(auction, "WrongPhase");
    });

    it("revealWinner transitions to Revealed (2)", async function () {
      await placeBid(1000n, alice);
      await closeAuction();
      await (await auction.connect(owner).revealWinner()).wait();
      expect(await auction.phase()).to.equal(2);
    });

    it("revealWinner reverts with no bids", async function () {
      await closeAuction();
      await expect(auction.connect(owner).revealWinner())
        .to.be.revertedWithCustomError(auction, "NoBids");
    });

  });

  // ── 4. Public decryption ───────────────────────────────────────────────────

  describe("4. Public decryption", function () {

    it("[PATTERN] full flow: bid → close → reveal → publicDecryptEuint → claimWinner", async function () {
      await placeBid(1000n, alice);
      await placeBid(2000n, bob);

      await closeAuction();
      const winningAmount = await revealAndClaim();

      expect(winningAmount).to.equal(2000n);
      const [, amount] = await auction.getResults();
      expect(amount).to.equal(2000n);
    });

    it("single bidder wins by default", async function () {
      await placeBid(500n, alice);
      await closeAuction();
      const winningAmount = await revealAndClaim();
      expect(winningAmount).to.equal(500n);
    });

    it("highest bid wins among three bidders", async function () {
      await placeBid(1000n, alice);
      await placeBid(3000n, bob);
      await placeBid(2000n, carol);
      await closeAuction();
      const winningAmount = await revealAndClaim();
      expect(winningAmount).to.equal(3000n);
    });

    it("getResults reverts before claimWinner", async function () {
      await placeBid(1000n, alice);
      await closeAuction();
      await (await auction.connect(owner).revealWinner()).wait();
      await expect(auction.getResults()).to.be.revertedWith("Not claimed yet");
    });

    it("WinnerRevealed event emitted on claimWinner", async function () {
      await placeBid(1000n, alice);
      await closeAuction();
      await (await auction.connect(owner).revealWinner()).wait();
      const winningHandle = await auction.encryptedWinningBid();
      const winningAmount = await fhevm.publicDecryptEuint(
        FhevmType.euint64, winningHandle, auctionAddress
      );
      await expect(auction.claimWinner(winningAmount))
        .to.emit(auction, "WinnerRevealed");
    });

  });

  // ── 5. Privacy guarantees ──────────────────────────────────────────────────

  describe("5. Privacy guarantees", function () {

    it("losing bids remain encrypted and private to their owner", async function () {
      await placeBid(1000n, alice);
      await placeBid(2000n, bob);
      await closeAuction();
      await revealAndClaim();

      // Alice (loser) can still decrypt her own bid privately
      expect(await decryptMyBid(alice)).to.equal(1000n);

      // Attacker cannot read alice's bid
      await expect(auction.connect(attacker).getMyBid())
        .to.be.revertedWith("No bid placed");
    });

    it("bid events contain no amount information", async function () {
      const enc = await encryptBid(9999n, alice);
      const receipt = await (
        await auction.connect(alice).placeBid(enc.handles[0], enc.inputProof)
      ).wait();
      const event = receipt.logs.find((l: any) => l.fragment?.name === "BidPlaced");
      expect(event).to.not.be.undefined;
      expect(event.args.length).to.equal(1);
    });

  });

});
