/**
 * ConfidentialVault.test.ts
 * Verified against docs.zama.org (May 2026)
 *
 * CORRECT API (from official Zama docs):
 *   import { FhevmType } from "@fhevm/hardhat-plugin"
 *   import { ethers, fhevm } from "hardhat"
 *
 *   Encrypt : fhevm.createEncryptedInput(addr, signerAddr).add64(value).encrypt()
 *   Decrypt : fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddr, signer)
 *
 * WRONG (do not use):
 *   fhevm.userDecrypt(...)         ← wrong function name
 *   getFhevmPlugin()               ← removed, plugin is HRE extension now
 */

import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("ConfidentialVault — Iteration 1", function () {

  let vault: any;
  let vaultAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("ConfidentialVault");
    vault = await Vault.deploy();
    await vault.waitForDeployment();
    vaultAddress = await vault.getAddress();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function encryptU64(value: bigint, caller: HardhatEthersSigner) {
    return fhevm
      .createEncryptedInput(vaultAddress, caller.address)
      .add64(value)
      .encrypt();
  }

  async function doDeposit(amount: bigint, signer: HardhatEthersSigner) {
    const enc = await encryptU64(amount, signer);
    const tx = await vault.connect(signer).deposit(enc.handles[0], enc.inputProof);
    await tx.wait();
  }

  async function doWithdraw(amount: bigint, signer: HardhatEthersSigner) {
    const enc = await encryptU64(amount, signer);
    const tx = await vault.connect(signer).withdraw(enc.handles[0], enc.inputProof);
    await tx.wait();
  }

  // Official decrypt pattern from docs.zama.org:
  // fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddress, signer)
  async function decryptBalance(signer: HardhatEthersSigner): Promise<bigint> {
    const handle = await vault.connect(signer).getBalance();
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, vaultAddress, signer);
  }

  // ── 1. Initial state ───────────────────────────────────────────────────────

  describe("1. Initial state", function () {

    it("owner is set correctly", async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("getBalance reverts before any deposit", async function () {
      await expect(vault.connect(alice).getBalance())
        .to.be.revertedWithCustomError(vault, "NoBalance");
    });

    it("getBalanceOf reverts for uninitialized user", async function () {
      await expect(vault.connect(alice).getBalanceOf(bob.address))
        .to.be.revertedWithCustomError(vault, "NoBalance");
    });

    it("withdraw reverts before any deposit", async function () {
      const enc = await encryptU64(100n, alice);
      await expect(vault.connect(alice).withdraw(enc.handles[0], enc.inputProof))
        .to.be.revertedWithCustomError(vault, "NoBalance");
    });

  });

  // ── 2. Deposit ─────────────────────────────────────────────────────────────

  describe("2. Deposit", function () {

    it("single deposit stores correct balance", async function () {
      await doDeposit(1000n, alice);
      expect(await decryptBalance(alice)).to.equal(1000n);
    });

    it("multiple deposits accumulate correctly", async function () {
      await doDeposit(500n, alice);
      await doDeposit(300n, alice);
      await doDeposit(200n, alice);
      expect(await decryptBalance(alice)).to.equal(1000n);
    });

    it("different users balances are independent", async function () {
      await doDeposit(1000n, alice);
      await doDeposit(2500n, bob);
      expect(await decryptBalance(alice)).to.equal(1000n);
      expect(await decryptBalance(bob)).to.equal(2500n);
    });

    it("Deposited event emits only user address — no amount", async function () {
      const enc = await encryptU64(1000n, alice);
      await expect(vault.connect(alice).deposit(enc.handles[0], enc.inputProof))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address);
    });

    it("[ANTI-PATTERN] alice proof cannot be replayed by bob", async function () {
      const enc = await encryptU64(1000n, alice);
      await expect(
        vault.connect(bob).deposit(enc.handles[0], enc.inputProof)
      ).to.be.reverted;
    });

    it("[ANTI-PATTERN] proof from vault cannot be used on different contract", async function () {
      const Vault2 = await ethers.getContractFactory("ConfidentialVault");
      const vault2 = await Vault2.deploy();
      await vault2.waitForDeployment();
      const enc = await encryptU64(1000n, alice);
      await expect(
        vault2.connect(alice).deposit(enc.handles[0], enc.inputProof)
      ).to.be.reverted;
    });

  });

  // ── 3. Withdraw ────────────────────────────────────────────────────────────

  describe("3. Withdraw", function () {

    beforeEach(async function () {
      await doDeposit(1000n, alice);
    });

    it("sufficient withdraw reduces balance correctly", async function () {
      await doWithdraw(400n, alice);
      expect(await decryptBalance(alice)).to.equal(600n);
    });

    it("exact-balance withdraw reduces to zero", async function () {
      await doWithdraw(1000n, alice);
      expect(await decryptBalance(alice)).to.equal(0n);
    });

    it("[PATTERN] insufficient withdraw leaves balance UNCHANGED — no revert", async function () {
      await doWithdraw(9999n, alice);
      expect(await decryptBalance(alice)).to.equal(1000n);
    });

    it("WithdrawAttempted event carries no outcome info", async function () {
      const enc = await encryptU64(9999n, alice);
      await expect(vault.connect(alice).withdraw(enc.handles[0], enc.inputProof))
        .to.emit(vault, "WithdrawAttempted")
        .withArgs(alice.address);
    });

    it("sequential withdraws work correctly", async function () {
      await doWithdraw(300n, alice);
      await doWithdraw(200n, alice);
      expect(await decryptBalance(alice)).to.equal(500n);
    });

    it("failed withdraw then valid withdraw works", async function () {
      await doWithdraw(9999n, alice);
      await doWithdraw(500n, alice);
      expect(await decryptBalance(alice)).to.equal(500n);
    });

    it("bob withdraw does not affect alice balance", async function () {
      await doDeposit(500n, bob);
      await doWithdraw(200n, bob);
      expect(await decryptBalance(alice)).to.equal(1000n);
      expect(await decryptBalance(bob)).to.equal(300n);
    });

  });

  // ── 4. ACL ─────────────────────────────────────────────────────────────────

  describe("4. ACL", function () {

    beforeEach(async function () {
      await doDeposit(1000n, alice);
    });

    it("alice can read her own balance", async function () {
      expect(await decryptBalance(alice)).to.equal(1000n);
    });

    it("[ACL] alice cannot read bob's balance", async function () {
      await doDeposit(500n, bob);
      await expect(vault.connect(alice).getBalanceOf(bob.address)).to.be.reverted;
    });

    it("[ACL] attacker cannot read alice's balance", async function () {
      await expect(vault.connect(attacker).getBalanceOf(alice.address)).to.be.reverted;
    });

    it("[ACL] owner has no special decryption rights on user balances", async function () {
      await expect(vault.connect(owner).getBalanceOf(alice.address)).to.be.reverted;
    });

    it("[ACL] non-owner cannot call getTotalDeposited", async function () {
      await expect(vault.connect(alice).getTotalDeposited())
        .to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("[ACL] non-owner cannot call grantOwnerTotalAccess", async function () {
      await expect(vault.connect(attacker).grantOwnerTotalAccess())
        .to.be.revertedWithCustomError(vault, "OnlyOwner");
    });

    it("[ACL] owner can decrypt total after grantOwnerTotalAccess", async function () {
      await vault.connect(owner).grantOwnerTotalAccess();
      const handle = await vault.connect(owner).getTotalDeposited();
      const total = await fhevm.userDecryptEuint(FhevmType.euint64, handle, vaultAddress, owner);
      expect(total).to.equal(1000n);
    });

  });

  // ── 5. Handle integrity ────────────────────────────────────────────────────

  describe("5. Handle integrity", function () {

    it("handle changes after each deposit", async function () {
      await doDeposit(500n, alice);
      const handle1 = await vault.connect(alice).getBalance();
      await doDeposit(500n, alice);
      const handle2 = await vault.connect(alice).getBalance();
      // Every FHE operation produces a new handle
      expect(handle1).to.not.equal(handle2);
      expect(await decryptBalance(alice)).to.equal(1000n);
    });

  });

  // ── 6. Edge cases ──────────────────────────────────────────────────────────

  describe("6. Edge cases", function () {

    it("deposit of zero is valid", async function () {
      await doDeposit(0n, alice);
      expect(await decryptBalance(alice)).to.equal(0n);
    });

    it("withdraw to zero then re-deposit works", async function () {
      await doDeposit(500n, alice);
      await doWithdraw(500n, alice);
      expect(await decryptBalance(alice)).to.equal(0n);
      await doDeposit(250n, alice);
      expect(await decryptBalance(alice)).to.equal(250n);
    });

    it("multiple users stay isolated across mixed operations", async function () {
      await doDeposit(100n, alice);
      await doDeposit(200n, bob);
      await doWithdraw(50n, alice);
      await doDeposit(100n, bob);
      expect(await decryptBalance(alice)).to.equal(50n);
      expect(await decryptBalance(bob)).to.equal(300n);
    });

  });

});