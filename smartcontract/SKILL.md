---
name: fhevm-smartcontract
description: >
  Use this skill when asked to write an FHEVM contract, build a confidential
  smart contract, use encrypted types, write FHE operations, implement access
  control with FHE.allow, handle encrypted inputs with input proofs, use
  FHE.select for branch-free logic, write a confidential ERC-20, implement
  ERC-7984, use externalEuint64 or externalEbool, call FHE.fromExternal,
  build a blind auction, write a private voting contract, or create any
  contract using Zama Protocol or fhEVM.
---

# fhEVM Smart Contract Skill

## What to do first

1. Check installed version — every API decision depends on this:
   ```bash
   cat node_modules/@fhevm/solidity/package.json | grep '"version"'
   ```
   Target: `0.11.x`. If below 0.11, stop and upgrade.

2. Read `resources/findings.md` before writing any contract code.

3. Use the confirmed working stack:
   ```
   @fhevm/solidity          0.11.x
   @openzeppelin/contracts  5.x
   solidity compiler        0.8.28
   evmVersion               cancun
   ```

4. Every contract MUST inherit `ZamaEthereumConfig`:
   ```solidity
   // SPDX-License-Identifier: BSD-3-Clause-Clear
   pragma solidity ^0.8.28;

   import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
   import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

   contract MyContract is ZamaEthereumConfig {
       // ...
   }
   ```

---

## Resource map

Read the smallest resource that matches the requested contract. Use examples as known-good patterns, not as copy-paste targets when the user asks for a different product.

- `resources/findings.md` — validated FHEVM smart contract findings and anti-patterns; read before designing or reviewing any contract.
- `resources/PrivateVoting.sol` — private voting with encrypted vote direction, vote accumulation, phase control, and public reveal patterns.
- `resources/BlindAuction.sol` — blind auction pattern with encrypted bids, running maximum logic, and post-decrypt winner handling.
- `resources/ConfidentialVault.sol` — encrypted balance/accounting pattern with deposits, withdrawals, ACL-gated views, and lazy initialization.
- `resources/ConfidentialDarkPool.sol` — encrypted order-flow pattern with plaintext ERC-20 custody, encrypted amounts/direction, matching, and settlement reveal.
- `resources/ConfidentialToken.sol` — ERC-7984 confidential token pattern using OpenZeppelin confidential contracts.
- `resources/MockERC20.sol` — plain ERC-20 test/development token used by hybrid examples such as the dark pool.

---

## Encrypted types — v0.11 API

### Input parameter types (for user-submitted encrypted values)
```
externalEbool     externalEuint8    externalEuint16   externalEuint32
externalEuint64   externalEuint128  externalEuint256  externalEaddress
```

### Storage types (for state variables)
```
ebool   euint8   euint16   euint32
euint64 euint128 euint256  eaddress
```

### Unwrap user input — ALWAYS use fromExternal
```solidity
function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
    euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
    // now safe to use amount
}
```

### Multiple inputs share one proof
```solidity
function submitOrder(
    externalEuint64 encryptedAmount,
    externalEuint8  encryptedDirection,
    bytes calldata  inputProof          // single proof covers both
) external {
    euint64 amount    = FHE.fromExternal(encryptedAmount, inputProof);
    euint8  direction = FHE.fromExternal(encryptedDirection, inputProof);
}
```

---

## ACL — mandatory after every FHE operation

```solidity
// After EVERY FHE operation that produces a new handle:
euint64 newBalance = FHE.add(_balances[msg.sender], amount);
_balances[msg.sender] = newBalance;
FHE.allowThis(newBalance);           // contract can operate on it
FHE.allow(newBalance, msg.sender);   // user can decrypt it
```

### Gate all view functions
```solidity
function getBalance() external view returns (euint64) {
    require(FHE.isInitialized(_balances[msg.sender]), "No balance");
    require(FHE.isSenderAllowed(_balances[msg.sender]), "Not allowed");
    return _balances[msg.sender];
}
```

### Admin access is NOT automatic
```solidity
// Contract ownership does NOT grant decryption rights
// Must explicitly grant via FHE.allow()
function grantAdminAccess() external onlyOwner {
    FHE.allow(_sensitiveValue, owner);
}
```

---

## Lazy initialization — never initialize FHE state in constructor

```solidity
// WRONG — reverts in v0.11
constructor() {
    _balance = FHE.asEuint64(0);
}

// CORRECT — lazy init inside functions
bool private _initialized;
function _init() internal {
    if (!_initialized) {
        _balance = FHE.asEuint64(0);
        FHE.allowThis(_balance);
        _initialized = true;
    }
}
```

---

## Branch-free logic — FHE.select replaces if/else

```solidity
// WRONG — ebool cannot be used in control flow
ebool hasFunds = FHE.ge(balance, amount);
if (hasFunds) { ... }          // compile error
require(hasFunds, "...");       // compile error

// CORRECT — FHE.select(condition, ifTrue, ifFalse)
ebool hasFunds  = FHE.ge(balance, amount);
euint64 newBal  = FHE.select(hasFunds, FHE.sub(balance, amount), balance);

// ALWAYS guard FHE.sub — wraps on underflow
ebool safe = FHE.ge(a, b);
euint64 result = FHE.select(safe, FHE.sub(a, b), FHE.asEuint64(0));
```

---

## Public decryption — v0.11 pattern

```solidity
// Contract: mark handle as publicly decryptable
euint64 publicHandle = FHE.makePubliclyDecryptable(_encryptedValue);
_publicHandle = publicHandle;
```
Frontend/test decrypts via `publicDecryptEuint()` — see frontend and testing skills.

---

## State machine pattern — mandatory for multi-phase contracts

```solidity
enum Phase { Active, Closed, Revealed }
Phase public phase;

modifier onlyPhase(Phase expected) {
    require(phase == expected, "Wrong phase");
    _;
}

function close() external onlyOwner onlyPhase(Phase.Active) {
    phase = Phase.Closed;
}
```

---

## ERC-7984 confidential token

```solidity
import { ERC7984 } from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";

contract ConfidentialToken is ZamaEthereumConfig, ERC7984, Ownable2Step {
    constructor(address owner, uint64 supply, string memory name, string memory symbol, string memory uri)
        ERC7984(name, symbol, uri)
        Ownable(owner)
    {
        _mint(owner, FHE.asEuint64(supply));
    }
}
```

ERC-7984 vs ERC-20:
```
balanceOf()      → confidentialBalanceOf() returns euint64
transfer()       → confidentialTransfer(addr, bytes32, bytes)  [use selector string]
approve()        → setOperator(addr, expiryTimestamp)
totalSupply()    → confidentialTotalSupply() returns euint64
```

Install: `npm install @openzeppelin/confidential-contracts @openzeppelin/contracts`

---

## Events — never leak private data

```solidity
// WRONG — amount observable in event
event Transfer(address from, address to, uint256 amount);

// CORRECT — no private payload
event Transfer(address indexed from, address indexed to);
```

---

## Findings

<!-- Populated from validated builds — see resources/findings.md -->

- F1:  Target @fhevm/solidity v0.11.x — check version before writing any code
- F2:  `einput` renamed to `externalEuint64`, `externalEbool`, etc. in v0.11
- F3:  `FHE.asEuint64(handle, proof)` renamed to `FHE.fromExternal(handle, proof)` in v0.11
- F4:  FHE calls in constructor body revert in v0.11 — use lazy init inside functions
- F10: Explicitly import every type used — `import { FHE, euint64, externalEuint64, ebool }`
- F11: Solidity version must be 0.8.28 with evmVersion cancun
- F13: Use `FHE.max(a, b)` instead of `FHE.select(FHE.gt(a, b), a, b)` for running max
- F14: Cannot assign plaintext address conditionally based on ebool — resolve post-decrypt
- F15: State machines are mandatory for multi-phase FHE contracts
- F19: Revealing one of two correlated encrypted values leaks the other — reveal atomically
- F20: FHE vote accumulation: update both counters with FHE.select in same operation
- F21: Not everything needs encryption — map each field to correct privacy level
- F22: Extract multi-field lazy init to internal function with bool initialized guard
- F23: ERC-7984 is NOT ERC-20 compatible — never assume API parity
- F25: Required imports for ERC-7984 — see contract header
- F26: NatSpec block comments with @ symbols cause compile errors — use // for package names
- F28: ERC-7984 constructor can call FHE via _mint() safely — direct FHE calls still revert
- F30: Multiple encrypted values share one inputProof — handle index order must match param order
- F31: externalEuint8 exists but must be explicitly imported
- F33: ERC-20 + FHE hybrid is valid — plaintext custody + encrypted order flow
- F34: All contracts in project must use same Solidity version as hardhat.config.ts

---

## Anti-patterns

```solidity
// AP-001: Branching on encrypted values
if (FHE.ge(a, b)) { ... }          // compile error — use FHE.select

// AP-002: Missing ACL after FHE operation
euint64 result = FHE.add(a, b);
_store = result;                    // result has zero permissions — will fail next call
// Fix: FHE.allowThis(result); FHE.allow(result, user);

// AP-003: Trivial ciphertext for secrets
euint64 secret = FHE.asEuint64(userValue); // visible to coprocessors
// Fix: use externalEuint64 + FHE.fromExternal(handle, proof)

// AP-004: FHE.sub without guard
euint64 diff = FHE.sub(a, b);      // wraps on underflow silently
// Fix: ebool safe = FHE.ge(a, b); diff = FHE.select(safe, FHE.sub(a, b), zero);

// AP-005: Reverting on private condition leaks info
require(FHE.ge(balance, amount));  // also compile error AND security violation
// Fix: silent fail via FHE.select

// AP-006: Emitting encrypted handles in events
event Deposit(address user, euint64 amount); // handle is observable metadata
// Fix: emit Deposit(address user); — no amount

// AP-007: FHE in constructor body
constructor() { _val = FHE.asEuint64(0); } // reverts in v0.11
// Fix: lazy init inside first function call
```

---

## Validation checklist

```
[ ] @fhevm/solidity version is 0.11.x
[ ] Contract inherits ZamaEthereumConfig
[ ] All encrypted inputs use externalEuintXX + FHE.fromExternal()
[ ] FHE.allowThis() + FHE.allow() called after every FHE operation
[ ] No FHE calls directly in constructor body
[ ] No if/else branching on ebool — FHE.select used throughout
[ ] FHE.sub() always guarded with FHE.ge() + FHE.select()
[ ] View functions gate with FHE.isSenderAllowed()
[ ] Events contain no encrypted amounts or handles
[ ] State machine enforced with modifier if multi-phase
[ ] FHE.isInitialized() checked before operating on stored handles
[ ] Both correlated encrypted values revealed atomically
[ ] Solidity version is 0.8.28 in hardhat.config.ts
```
