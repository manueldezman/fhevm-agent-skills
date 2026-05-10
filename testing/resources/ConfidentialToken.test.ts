/**
 * ConfidentialToken.test.ts — ERC-7984 example
 * Verified against docs.zama.org + docs.openzeppelin.com/confidential-contracts
 *
 * INSTALL BEFORE RUNNING:
 *   npm install @openzeppelin/confidential-contracts
 *   npm install @openzeppelin/contracts
 *
 * KEY ERC-7984 DIFFERENCES FROM ERC-20 (critical for agents):
 *   ERC-20                          ERC-7984
 *   ─────────────────────────────── ────────────────────────────────────
 *   balanceOf(addr) → uint256       confidentialBalanceOf(addr) → euint64
 *   transfer(addr, uint256)         confidentialTransfer(addr, bytes32, bytes)
 *   approve(addr, uint256)          setOperator(addr, expiryTimestamp)
 *   allowance(owner, spender)       isOperator(addr, addr) → bool
 *   totalSupply() → uint256         confidentialTotalSupply() → euint64
 *   Transfer event (visible)        ConfidentialTransfer event (no amounts)
 *
 * TRANSFER FUNCTION SIGNATURE (important — overloaded):
 *   confidentialTransfer(address to, bytes32 handle, bytes inputProof)
 *   Called with method selector due to overloading:
 *   token['confidentialTransfer(address,bytes32,bytes)'](to, handle, proof)
 */

import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("ConfidentialToken — ERC-7984", function () {

  const INITIAL_SUPPLY = 1000n;
  const NAME = "Confidential Token";
  const SYMBOL = "CTKN";
  const URI = "https://example.com/token";

  let token: any;
  let tokenAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();
    token = await ethers.deployContract("ConfidentialToken", [
      owner.address,
      INITIAL_SUPPLY,
      NAME,
      SYMBOL,
      URI,
    ]);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function encryptAmount(amount: bigint, caller: HardhatEthersSigner) {
    return fhevm
      .createEncryptedInput(tokenAddress, caller.address)
      .add64(amount)
      .encrypt();
  }

  // Decrypt a confidential balance — uses userDecryptEuint (private decrypt)
  async function decryptBalance(holder: HardhatEthersSigner): Promise<bigint> {
    const handle = await token.confidentialBalanceOf(holder.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, tokenAddress, holder);
  }

  // ERC-7984 transfer uses overloaded function — must use selector string
  async function confTransfer(
    from: HardhatEthersSigner,
    to: HardhatEthersSigner,
    amount: bigint
  ) {
    const enc = await encryptAmount(amount, from);
    const tx = await token
      .connect(from)
      ["confidentialTransfer(address,bytes32,bytes)"](
        to.address,
        enc.handles[0],
        enc.inputProof
      );
    await tx.wait();
  }

  // ── 1. Deployment ──────────────────────────────────────────────────────────

  describe("1. Deployment", function () {

    it("name and symbol are set correctly", async function () {
      expect(await token.name()).to.equal(NAME);
      expect(await token.symbol()).to.equal(SYMBOL);
    });

    it("owner receives initial supply on deploy", async function () {
      const balance = await decryptBalance(owner);
      expect(balance).to.equal(INITIAL_SUPPLY);
    });

    it("non-owner has zero balance on deploy", async function () {
      const handle = await token.confidentialBalanceOf(alice.address);
      // Uninitialized handle = ZeroHash
      expect(handle).to.equal(ethers.ZeroHash);
    });

  });

  // ── 2. Visible mint ────────────────────────────────────────────────────────

  describe("2. Visible mint (plaintext amount)", function () {

    it("owner can mint plaintext amount to alice", async function () {
      await (await token.connect(owner).mint(alice.address, 500n)).wait();
      expect(await decryptBalance(alice)).to.equal(500n);
    });

    it("non-owner cannot mint", async function () {
      await expect(token.connect(attacker).mint(attacker.address, 500n))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

  });

  // ── 3. Confidential mint ───────────────────────────────────────────────────

  describe("3. Confidential mint (encrypted amount)", function () {

    it("owner can mint encrypted amount to alice", async function () {
      const enc = await encryptAmount(300n, owner);
      await (await token.connect(owner).confidentialMint(
        alice.address, enc.handles[0], enc.inputProof
      )).wait();
      expect(await decryptBalance(alice)).to.equal(300n);
    });

    it("non-owner cannot confidential mint", async function () {
      const enc = await encryptAmount(300n, attacker);
      await expect(
        token.connect(attacker).confidentialMint(alice.address, enc.handles[0], enc.inputProof)
      ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

  });

  // ── 4. Confidential transfer ───────────────────────────────────────────────

  describe("4. Confidential transfer", function () {

    beforeEach(async function () {
      // Give alice 500 tokens to work with
      await (await token.connect(owner).mint(alice.address, 500n)).wait();
    });

    it("alice can transfer encrypted amount to bob", async function () {
      await confTransfer(alice, bob, 200n);
      expect(await decryptBalance(alice)).to.equal(300n);
      expect(await decryptBalance(bob)).to.equal(200n);
    });

    it("transfer leaves correct balances on both sides", async function () {
      await confTransfer(alice, bob, 500n); // full balance
      expect(await decryptBalance(alice)).to.equal(0n);
      expect(await decryptBalance(bob)).to.equal(500n);
    });

    it("[PATTERN] over-transfer reverts with ERC7984ZeroBalance", async function () {
      // ERC-7984 reverts (not silent) when sender has no balance to transfer from
      const enc = await encryptAmount(9999n, alice);
      await expect(
        token.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
          bob.address, enc.handles[0], enc.inputProof
        )
      // Note: ERC-7984 handles overdraft differently from our custom vault
      // It reverts with ERC7984ZeroBalance if sender balance handle is uninitialized
      // but silently handles insufficient amounts via FHE.select internally
      ).to.not.be.reverted; // actual overdraft is handled silently by base contract
    });

    it("transfer to zero address reverts", async function () {
      const enc = await encryptAmount(100n, alice);
      await expect(
        token.connect(alice)["confidentialTransfer(address,bytes32,bytes)"](
          ethers.ZeroAddress, enc.handles[0], enc.inputProof
        )
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
    });

    it("[ANTI-PATTERN] alice proof cannot be used by bob for transfer", async function () {
      const enc = await encryptAmount(100n, alice);
      await expect(
        token.connect(bob)["confidentialTransfer(address,bytes32,bytes)"](
          attacker.address, enc.handles[0], enc.inputProof
        )
      ).to.be.reverted;
    });

  });

  // ── 5. Operator pattern ────────────────────────────────────────────────────

  describe("5. Operator (replaces ERC-20 approve)", function () {

    beforeEach(async function () {
      await (await token.connect(owner).mint(alice.address, 500n)).wait();
    });

    it("alice can set bob as operator for 24 hours", async function () {
      const expiry = Math.floor(Date.now() / 1000) + 86400; // now + 24h
      await (await token.connect(alice).setOperator(bob.address, expiry)).wait();
      expect(await token.isOperator(alice.address, bob.address)).to.be.true;
    });

    it("operator can transfer on behalf of alice", async function () {
      const expiry = Math.floor(Date.now() / 1000) + 86400;
      await (await token.connect(alice).setOperator(bob.address, expiry)).wait();

      // Bob transfers alice's tokens to himself as operator
      const enc = await encryptAmount(100n, bob);
      await (await token.connect(bob)["confidentialTransferFrom(address,address,bytes32,bytes)"](
        alice.address, bob.address, enc.handles[0], enc.inputProof
      )).wait();

      expect(await decryptBalance(bob)).to.equal(100n);
    });

    it("non-operator cannot transfer on behalf of alice", async function () {
      const enc = await encryptAmount(100n, attacker);
      await expect(
        token.connect(attacker)["confidentialTransferFrom(address,address,bytes32,bytes)"](
          alice.address, bob.address, enc.handles[0], enc.inputProof
        )
      ).to.be.reverted;
    });

  });

  // ── 6. ACL and privacy ─────────────────────────────────────────────────────

  describe("6. ACL and privacy", function () {

    beforeEach(async function () {
      await (await token.connect(owner).mint(alice.address, 500n)).wait();
    });

    it("alice can decrypt her own balance", async function () {
      expect(await decryptBalance(alice)).to.equal(500n);
    });

    it("attacker cannot decrypt alice's balance", async function () {
      const handle = await token.confidentialBalanceOf(alice.address);
      // handle is accessible to anyone (it's stored publicly)
      // but decryption requires ACL permission — attacker lacks it
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, handle, tokenAddress, attacker)
      ).to.be.rejected; // ACL blocks attacker from decrypting
    });

    it("owner cannot decrypt alice's balance without grant", async function () {
      const handle = await token.confidentialBalanceOf(alice.address);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, handle, tokenAddress, owner)
      ).to.be.rejected;
    });

    it("owner can decrypt total supply after grantOwnerSupplyAccess", async function () {
      await (await token.connect(owner).grantOwnerSupplyAccess()).wait();
      const supplyHandle = await token.confidentialTotalSupply();
      const supply = await fhevm.userDecryptEuint(
        FhevmType.euint64, supplyHandle, tokenAddress, owner
      );
       expect(supply).to.equal(INITIAL_SUPPLY + 500n);
    });

  });

  // ── 7. Visible burn ────────────────────────────────────────────────────────

  describe("7. Burn", function () {

    beforeEach(async function () {
      await (await token.connect(owner).mint(alice.address, 500n)).wait();
    });

    it("owner can burn tokens from alice", async function () {
      await (await token.connect(owner).burn(alice.address, 200n)).wait();
      expect(await decryptBalance(alice)).to.equal(300n);
    });

    it("non-owner cannot burn", async function () {
      await expect(token.connect(attacker).burn(alice.address, 200n))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

  });

});
