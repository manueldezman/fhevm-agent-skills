---
name: fhevm-testing
description: >
  Use this skill when asked to test an FHEVM contract, write Hardhat tests
  for encrypted inputs, test FHE operations, test access control, decrypt
  user values in tests, test public decrypt, use fhevm.userDecryptEuint,
  use fhevm.publicDecryptEuint, test encrypted balances, test blind auction,
  test private voting, test input proof replay attacks, advance time in
  Hardhat tests, or validate encrypted state after transactions.
---

# fhEVM Testing Skill

## What to do first

1. Read `resources/test-patterns.md` before writing any test.

2. Confirm the plugin is correctly installed:
   ```bash
   cat node_modules/@fhevm/hardhat-plugin/package.json | grep '"version"'
   ```

3. Use correct imports — nothing else works:
   ```typescript
   import { FhevmType } from "@fhevm/hardhat-plugin";
   import { ethers, fhevm } from "hardhat";  // fhevm is HRE extension
   import { expect } from "chai";
   ```

4. Run modes:
   ```bash
   npx hardhat test                      # in-memory mock — fastest, use for CI
   npx hardhat test --network localhost  # local node mock — persistent state
   npx hardhat test --network sepolia    # real FHE — final validation only
   ```

---

## Resource map

Read `resources/test-patterns.md` first, then load the test example that matches the contract being built or reviewed.

- `resources/test-patterns.md` — compact reference for imports, encryption, user decrypt, public decrypt, handle types, transaction waits, and time advancement.
- `resources/PrivateVoting.test.ts` — tests encrypted voting, ACL behavior, vote reveal, and phase transitions.
- `resources/BlindAuction.test.ts` — tests encrypted bids, auction timing, winner/finalization flow, and public decrypt behavior.
- `resources/ConfidentialVault.test.ts` — tests encrypted balance updates, deposits, withdrawals, ACL-gated views, and insufficient-balance branches.
- `resources/ConfidentialDarkPool.test.ts` — tests ERC-20 deposit flow plus encrypted order submission, multi-handle shared proofs, matching, and privacy assertions.
- `resources/ConfidentialToken.test.ts` — tests ERC-7984-style confidential balances, encrypted transfers, overloaded function calls, and confidential total supply behavior.

---

## Encrypting inputs in tests

### Single value
```typescript
const enc = await fhevm
  .createEncryptedInput(contractAddress, caller.address)
  .add64(1000n)
  .encrypt();

await contract.connect(caller).deposit(enc.handles[0], enc.inputProof);
```

### Multiple values — shared proof, order matters
```typescript
const enc = await fhevm
  .createEncryptedInput(contractAddress, caller.address)
  .add64(1000n)   // handles[0]
  .add8(1)        // handles[1]
  .encrypt();

// handles index must match contract parameter order exactly
await contract.submitOrder(enc.handles[0], enc.handles[1], enc.inputProof);
```

### Type mapping
```
.addBool(true/false)  → externalEbool    parameter
.add8(n)              → externalEuint8   parameter
.add16(n)             → externalEuint16  parameter
.add32(n)             → externalEuint32  parameter
.add64(n)             → externalEuint64  parameter
.add128(n)            → externalEuint128 parameter
.addAddress(addr)     → externalEaddress parameter
```

---

## Decrypting in tests

### User decrypt (private values — ACL-gated)
```typescript
// Returns bigint — ALWAYS compare with bigint literals (1000n not 1000)
const handle = await contract.connect(alice).getBalance();
const clear  = await fhevm.userDecryptEuint(
  FhevmType.euint64,
  handle,           // hex string — do NOT convert
  contractAddress,
  alice             // must be the ACL-permitted signer
);
expect(clear).to.equal(1000n);
```

### Public decrypt (publicly decryptable handles)
```typescript
// Handle must have been marked FHE.makePubliclyDecryptable() on-chain
const handle = await contract.publicHandle();
const clear  = await fhevm.publicDecryptEuint(
  FhevmType.euint64,
  handle,
  contractAddress   // no signer needed
);
expect(clear).to.equal(2000n);
```

### Multi-value public decrypt — separate calls per handle
```typescript
// No batch API — call separately for each handle
const yesHandle = await contract.publicYesHandle();
const noHandle  = await contract.publicNoHandle();
const yes = await fhevm.publicDecryptEuint(FhevmType.euint64, yesHandle, contractAddr);
const no  = await fhevm.publicDecryptEuint(FhevmType.euint64, noHandle,  contractAddr);
```

### FhevmType mapping
```
FhevmType.ebool     FhevmType.euint8    FhevmType.euint16
FhevmType.euint32   FhevmType.euint64   FhevmType.euint128
FhevmType.euint256  FhevmType.eaddress
```

### Handle type from ethers — already a hex string
```typescript
// euint64 handle returned by ethers is ALREADY a hex string
// Do NOT convert with toString(16) — it breaks decryption
const handle = await contract.getBalance(); // type: string "0x856eb..."
await fhevm.userDecryptEuint(FhevmType.euint64, handle, addr, signer); // pass directly
```

---

## Time advancement — no external package needed

```typescript
// No need for @nomicfoundation/hardhat-network-helpers
async function advanceTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
```

---

## Sequential operations — always await tx.wait()

```typescript
// WRONG — operations race, encrypted state corrupted silently
await contract.deposit(enc.handles[0], enc.inputProof);
await contract.withdraw(enc2.handles[0], enc2.inputProof);

// CORRECT — wait for each transaction before the next
const tx1 = await contract.deposit(enc.handles[0], enc.inputProof);
await tx1.wait();
const tx2 = await contract.withdraw(enc2.handles[0], enc2.inputProof);
await tx2.wait();
```

---

## ERC-7984 transfer — overloaded functions require selector string

```typescript
// WRONG — ethers cannot resolve overloaded function
await token.confidentialTransfer(to, handle, proof);

// CORRECT — use full selector string
await token["confidentialTransfer(address,bytes32,bytes)"](to, handle, proof);
await token["confidentialTransferFrom(address,address,bytes32,bytes)"](from, to, handle, proof);
```

---

## ERC-20 approvals — approve inside helpers not beforeEach

```typescript
// WRONG — fixed approval exhausted when helper called multiple times
beforeEach(async () => {
  await token.connect(alice).approve(poolAddress, AMOUNT); // exhausted after first use
});

// CORRECT — fresh approval inside the helper every call
async function depositTokens(trader: HardhatEthersSigner, amount: bigint) {
  await token.connect(trader).approve(contractAddress, amount); // fresh each time
  await contract.connect(trader).deposit(tokenAddress, amount);
}
```

---

## Test file boilerplate

```typescript
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

describe("MyContract", function () {
  let contract: any;
  let contractAddress: string;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, alice] = await ethers.getSigners();
    contract = await ethers.deployContract("MyContract", [/* constructor args */]);
    await contract.waitForDeployment();
    contractAddress = await contract.getAddress();
  });
});
```

---

## Findings

<!-- Populated from validated builds — see resources/test-patterns.md and example tests -->

- F1:  Check @fhevm/solidity version first — all API decisions depend on it (v0.11.x target)
- F5:  fhevm.userDecrypt() does not exist — correct: fhevm.userDecryptEuint(FhevmType.euintXX, handle, addr, signer)
- F6:  Handle returned by ethers is already a hex string — do NOT convert with toString(16) — pass directly
- F7:  await tx.wait() is mandatory between sequential FHE operations — missing causes silent state corruption
- F8:  @nomicfoundation/hardhat-toolbox must use @hh2 tag: npm install "@nomicfoundation/hardhat-toolbox@hh2"
- F9:  fhevm plugin only works inside hardhat test — calling from hardhat run scripts throws HardhatFhevmError
- F11: Solidity version must be 0.8.28 in hardhat.config.ts — mismatches cause compile errors
- F12: FHE.requestDecryption/toBytes32/checkSignatures/simulateDecryption do not exist in v0.11 — use FHE.makePubliclyDecryptable + fhevm.publicDecryptEuint
- F16: Time advancement uses ethers.provider.send("evm_increaseTime") — no extra package needed
- F18: Multi-value public decrypt requires separate publicDecryptEuint() call per handle — no batch API
- F23: ERC-7984 is not ERC-20 — confidentialBalanceOf returns euint64, not uint256
- F24: ERC-7984 transfer functions are overloaded — must use full selector string in tests
- F27: ERC-7984 confidentialTotalSupply() accumulates across ALL mints including constructor mint
- F29: ERC-20 allowances exhaust across multiple test calls — approve inside helpers not beforeEach
- F30: Multiple encrypted values share one inputProof — handle index order must match contract param order

---

## Anti-patterns

```typescript
// AP-T001: Wrong decrypt function name
await fhevm.userDecrypt(handle, addr, signer);          // does not exist
await fhevm.userDecryptEuint(FhevmType.euint64, ...);   // correct

// AP-T002: Converting handle type breaks decryption
const hex = "0x" + handle.toString(16).padStart(64, "0"); // WRONG
// Fix: pass handle directly — already a hex string

// AP-T003: Missing tx.wait() between operations
await contract.deposit(h1, p1);
await contract.withdraw(h2, p2); // races with deposit → corrupted encrypted state
// Fix: const tx = await contract.deposit(...); await tx.wait();

// AP-T004: Comparing decrypted value with number not bigint
expect(clear).to.equal(1000);   // fails — clear is bigint
expect(clear).to.equal(1000n);  // correct

// AP-T005: getFhevmPlugin() import — removed from plugin
import { getFhevmPlugin } from "@fhevm/hardhat-plugin"; // TypeError at runtime
// Fix: import { fhevm } from "hardhat" — fhevm is HRE extension

// AP-T006: Using fhevm in hardhat run script
npx hardhat run scripts/debug.ts  // HardhatFhevmError: plugin not initialized
// Fix: fhevm only works inside npx hardhat test context

// AP-T007: Fixed ERC-20 approval in beforeEach
beforeEach(() => token.approve(pool, AMOUNT)); // exhausts on second deposit call
// Fix: approve fresh inside the deposit helper function

// AP-T008: No batch public decrypt API
await fhevm.publicDecryptEuint([handle1, handle2], ...); // does not exist
// Fix: two separate calls — one per handle
```

---

## Mandatory test checklist

```
[ ] Imports: FhevmType from "@fhevm/hardhat-plugin", fhevm from "hardhat"
[ ] Every encrypt: .addXX() type matches contract externalEuintXX param type
[ ] Every user decrypt: fhevm.userDecryptEuint(FhevmType.euintXX, handle, addr, signer)
[ ] Every public decrypt: fhevm.publicDecryptEuint(FhevmType.euintXX, handle, addr)
[ ] All decrypted comparisons use bigint literals (1000n not 1000)
[ ] Every sequential operation has tx.wait() before next call
[ ] Uninitialized handle asserted as ethers.ZeroHash
[ ] Proof replay: alice's proof rejected when submitted by bob
[ ] Proof replay: vault1 proof rejected on vault2
[ ] ACL: unauthorized address reverts on view functions
[ ] ERC-20 approvals inside helpers not beforeEach
[ ] ERC-7984 transfer uses full selector string
[ ] Time advancement: evm_increaseTime + evm_mine — no external package
[ ] Both FHE.select branches tested (sufficient AND insufficient cases)
[ ] Multi-value public decrypt uses separate call per handle
```
