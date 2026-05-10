/**
 * PrivateVoting.test.ts — Iteration 2b
 *
 * NEW PATTERNS vs Iteration 2a:
 *   - externalEbool input type (not euint64)
 *   - fhevm.createEncryptedInput().addBool(value).encrypt()
 *   - Multi-value public decrypt (yes AND no handles separately)
 *   - fhevm.publicDecryptEuint() called twice for two handles
 *   - Whitelist enforcement testing
 *   - One-vote-per-address enforcement
 *
 * VERIFIED API (v0.11):
 *   Encrypt bool : fhevm.createEncryptedInput(addr, caller).addBool(true/false).encrypt()
 *   Public decrypt: fhevm.publicDecryptEuint(FhevmType.euint64, handle, contractAddr)
 */

import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("PrivateVoting — Iteration 2b", function () {

  const VOTING_DURATION = 3600;
  const PROPOSAL = "Should we upgrade the protocol?";

  let voting: any;
  let votingAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  // ── Deploy helpers ─────────────────────────────────────────────────────────

  async function deployVoting(whitelistEnabled = false) {
    const Voting = await ethers.getContractFactory("PrivateVoting");
    voting = await Voting.deploy(PROPOSAL, VOTING_DURATION, whitelistEnabled);
    await voting.waitForDeployment();
    votingAddress = await voting.getAddress();
  }

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, attacker] = await ethers.getSigners();
    await deployVoting(false); // open voting by default
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function advanceTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // NEW PATTERN: encrypt a boolean vote
  async function encryptVote(support: boolean, voter: HardhatEthersSigner) {
    return fhevm
      .createEncryptedInput(votingAddress, voter.address)
      .addBool(support)
      .encrypt();
  }

  async function castVote(support: boolean, voter: HardhatEthersSigner) {
    const enc = await encryptVote(support, voter);
    const tx = await voting.connect(voter).vote(enc.handles[0], enc.inputProof);
    await tx.wait();
  }

  async function endAndReveal(): Promise<{ yes: bigint; no: bigint }> {
    await advanceTime(VOTING_DURATION + 1);
    await (await voting.connect(owner).endVoting()).wait();
    await (await voting.connect(owner).revealResults()).wait();

    // Get publicly decryptable handles
    const yesHandle = await voting.publicYesHandle();
    const noHandle  = await voting.publicNoHandle();

    // Decrypt both tallies
    const yes = await fhevm.publicDecryptEuint(FhevmType.euint64, yesHandle, votingAddress);
    const no  = await fhevm.publicDecryptEuint(FhevmType.euint64, noHandle,  votingAddress);

    // Submit results on-chain
    await (await voting.submitResults(yes, no)).wait();

    return { yes, no };
  }

  // ── 1. Initial state ───────────────────────────────────────────────────────

  describe("1. Initial state", function () {

    it("status is Active (0)", async function () {
      expect(await voting.status()).to.equal(0);
    });

    it("proposal title is set correctly", async function () {
      expect(await voting.proposalTitle()).to.equal(PROPOSAL);
    });

    it("owner is set correctly", async function () {
      expect(await voting.owner()).to.equal(owner.address);
    });

    it("totalVotesCast starts at zero", async function () {
      expect(await voting.totalVotesCast()).to.equal(0);
    });

    it("endVoting reverts if deadline not reached", async function () {
      await expect(voting.connect(owner).endVoting())
        .to.be.revertedWith("Deadline not reached");
    });

    it("revealResults reverts in Active status", async function () {
      await expect(voting.connect(owner).revealResults())
        .to.be.revertedWithCustomError(voting, "WrongStatus");
    });

  });

  // ── 2. Voting ──────────────────────────────────────────────────────────────

  describe("2. Voting", function () {

    it("voter can cast yes vote", async function () {
      await castVote(true, alice);
      expect(await voting.hasVoted(alice.address)).to.be.true;
      expect(await voting.totalVotesCast()).to.equal(1);
    });

    it("voter can cast no vote", async function () {
      await castVote(false, alice);
      expect(await voting.hasVoted(alice.address)).to.be.true;
    });

    it("VoteCast event emits only voter address — no direction", async function () {
      const enc = await encryptVote(true, alice);
      await expect(voting.connect(alice).vote(enc.handles[0], enc.inputProof))
        .to.emit(voting, "VoteCast")
        .withArgs(alice.address);
    });

    it("multiple voters can vote independently", async function () {
      await castVote(true, alice);
      await castVote(false, bob);
      await castVote(true, carol);
      expect(await voting.totalVotesCast()).to.equal(3);
    });

    it("[PATTERN] voter cannot vote twice", async function () {
      await castVote(true, alice);
      const enc = await encryptVote(false, alice);
      await expect(voting.connect(alice).vote(enc.handles[0], enc.inputProof))
        .to.be.revertedWithCustomError(voting, "AlreadyVoted");
    });

    it("voting reverts after deadline", async function () {
      await advanceTime(VOTING_DURATION + 1);
      const enc = await encryptVote(true, alice);
      await expect(voting.connect(alice).vote(enc.handles[0], enc.inputProof))
        .to.be.revertedWith("Voting deadline reached");
    });

    it("[ANTI-PATTERN] alice proof cannot be used by bob", async function () {
      const enc = await encryptVote(true, alice);
      await expect(voting.connect(bob).vote(enc.handles[0], enc.inputProof))
        .to.be.reverted;
    });

    it("[PRIVACY] hasVoted reveals WHO voted but not HOW", async function () {
      await castVote(true, alice);
      await castVote(false, bob);
      // Both are public — but direction is hidden
      expect(await voting.hasVoted(alice.address)).to.be.true;
      expect(await voting.hasVoted(bob.address)).to.be.true;
      expect(await voting.hasVoted(carol.address)).to.be.false;
    });

  });

  // ── 3. Whitelist ───────────────────────────────────────────────────────────

  describe("3. Whitelist", function () {

    beforeEach(async function () {
      await deployVoting(true); // whitelist enabled
    });

    it("eligible voter can vote", async function () {
      await (await voting.connect(owner).addEligibleVoter(alice.address)).wait();
      await castVote(true, alice);
      expect(await voting.hasVoted(alice.address)).to.be.true;
    });

    it("non-eligible voter cannot vote", async function () {
      const enc = await encryptVote(true, attacker);
      await expect(voting.connect(attacker).vote(enc.handles[0], enc.inputProof))
        .to.be.revertedWithCustomError(voting, "NotEligible");
    });

    it("batch add eligible voters works", async function () {
      await (await voting.connect(owner).addEligibleVoters(
        [alice.address, bob.address, carol.address]
      )).wait();
      await castVote(true, alice);
      await castVote(false, bob);
      expect(await voting.totalVotesCast()).to.equal(2);
    });

    it("non-owner cannot add eligible voters", async function () {
      await expect(voting.connect(attacker).addEligibleVoter(attacker.address))
        .to.be.revertedWithCustomError(voting, "OnlyOwner");
    });

  });

  // ── 4. Phase transitions ───────────────────────────────────────────────────

  describe("4. Phase transitions", function () {

    it("endVoting transitions to Ended (1)", async function () {
      await castVote(true, alice);
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      expect(await voting.status()).to.equal(1);
    });

    it("non-owner cannot end voting", async function () {
      await advanceTime(VOTING_DURATION + 1);
      await expect(voting.connect(attacker).endVoting())
        .to.be.revertedWithCustomError(voting, "OnlyOwner");
    });

    it("cannot vote in Ended status", async function () {
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      const enc = await encryptVote(true, alice);
      await expect(voting.connect(alice).vote(enc.handles[0], enc.inputProof))
        .to.be.revertedWithCustomError(voting, "WrongStatus");
    });

    it("revealResults transitions to Revealed (2)", async function () {
      await castVote(true, alice);
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      await (await voting.connect(owner).revealResults()).wait();
      expect(await voting.status()).to.equal(2);
    });

    it("revealResults reverts with no votes cast", async function () {
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      await expect(voting.connect(owner).revealResults())
        .to.be.revertedWith("No votes cast");
    });

  });

  // ── 5. Results ─────────────────────────────────────────────────────────────

  describe("5. Results — public decryption", function () {

    it("[PATTERN] full flow: vote → end → reveal → publicDecryptEuint → submit", async function () {
      await castVote(true, alice);
      await castVote(true, bob);
      await castVote(false, carol);

      const { yes, no } = await endAndReveal();

      expect(yes).to.equal(2n);
      expect(no).to.equal(1n);

      const [yesResult, noResult] = await voting.getResults();
      expect(yesResult).to.equal(2n);
      expect(noResult).to.equal(1n);
    });

    it("unanimous yes vote", async function () {
      await castVote(true, alice);
      await castVote(true, bob);
      await castVote(true, carol);
      const { yes, no } = await endAndReveal();
      expect(yes).to.equal(3n);
      expect(no).to.equal(0n);
    });

    it("unanimous no vote", async function () {
      await castVote(false, alice);
      await castVote(false, bob);
      const { yes, no } = await endAndReveal();
      expect(yes).to.equal(0n);
      expect(no).to.equal(2n);
    });

    it("single vote produces correct tally", async function () {
      await castVote(true, alice);
      const { yes, no } = await endAndReveal();
      expect(yes).to.equal(1n);
      expect(no).to.equal(0n);
    });

    it("ResultsRevealed event emitted on submitResults", async function () {
      await castVote(true, alice);
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      await (await voting.connect(owner).revealResults()).wait();

      const yesHandle = await voting.publicYesHandle();
      const noHandle  = await voting.publicNoHandle();
      const yes = await fhevm.publicDecryptEuint(FhevmType.euint64, yesHandle, votingAddress);
      const no  = await fhevm.publicDecryptEuint(FhevmType.euint64, noHandle,  votingAddress);

      await expect(voting.submitResults(yes, no))
        .to.emit(voting, "ResultsRevealed")
        .withArgs(yes, no);
    });

    it("getResults reverts before submitResults", async function () {
      await castVote(true, alice);
      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      await (await voting.connect(owner).revealResults()).wait();
      await expect(voting.getResults()).to.be.revertedWith("Not submitted yet");
    });

    it("submitResults cannot be called twice", async function () {
      await castVote(true, alice);
      const { yes, no } = await endAndReveal();
      await expect(voting.submitResults(yes, no))
        .to.be.revertedWith("Already submitted");
    });

  });

  // ── 6. Privacy guarantees ──────────────────────────────────────────────────

  describe("6. Privacy guarantees", function () {

    it("[PRIVACY] individual vote direction is never revealed", async function () {
      await castVote(true, alice);
      await castVote(false, bob);

      // Even after reveal, we only know totals — not who voted which way
      const { yes, no } = await endAndReveal();
      expect(yes + no).to.equal(2n); // total matches
      // We know 1 yes and 1 no but cannot attribute to alice or bob
    });

    it("[PRIVACY] both tallies revealed atomically", async function () {
      await castVote(true, alice);
      await castVote(true, bob);
      await castVote(false, carol);

      await advanceTime(VOTING_DURATION + 1);
      await (await voting.connect(owner).endVoting()).wait();
      await (await voting.connect(owner).revealResults()).wait();

      // Both handles are publicly decryptable — not just one
      const yesHandle = await voting.publicYesHandle();
      const noHandle  = await voting.publicNoHandle();

      expect(yesHandle).to.not.equal(ethers.ZeroHash);
      expect(noHandle).to.not.equal(ethers.ZeroHash);
    });

    it("[PRIVACY] total votes cast is public info (who voted is observable)", async function () {
      await castVote(true, alice);
      await castVote(false, bob);
      // totalVotesCast is intentionally public — prevents cheating about participation
      expect(await voting.totalVotesCast()).to.equal(2);
    });

  });

});
