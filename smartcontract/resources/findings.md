# fhEVM Smart Contract Findings
# Derived from building and testing 5 contracts across 4 iterations
# All findings confirmed against @fhevm/solidity v0.11.1

## F1 — Version detection is mandatory
Target stack (May 2026):
  @fhevm/solidity: 0.11.1
  @fhevm/hardhat-plugin: latest
  @nomicfoundation/hardhat-toolbox: @hh2 tag
  solidity: 0.8.28, evmVersion: cancun

Check: cat node_modules/@fhevm/solidity/package.json | grep '"version"'

## F2 — einput renamed to externalEuintXX in v0.11
OLD: function deposit(einput enc, bytes calldata proof)
NEW: function deposit(externalEuint64 enc, bytes calldata proof)

## F3 — FHE.asEuint64(handle, proof) renamed to FHE.fromExternal()
OLD: euint64 val = FHE.asEuint64(encryptedInput, proof);
NEW: euint64 val = FHE.fromExternal(encryptedInput, proof);

## F4 — FHE calls directly in constructor body revert in v0.11
WRONG: constructor() { _balance = FHE.asEuint64(0); }
CORRECT: lazy init inside first function call using bool initialized guard

## F10 — All types must be explicitly imported
WRONG: import "@fhevm/solidity/lib/FHE.sol";
CORRECT: import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";

## F11 — Solidity 0.8.28 + evmVersion cancun required
Older versions cause subtle compile issues with fhEVM types.

## F13 — FHE.max() preferred over FHE.select + FHE.gt for running maximum
FHE.max(a, b) is cleaner and cheaper than FHE.select(FHE.gt(a,b), a, b)

## F14 — Cannot assign plaintext address conditionally based on ebool
ebool cannot be used in if/else. Defer winner/address resolution to post-decrypt.
Store all candidates, resolve after FHE.makePubliclyDecryptable + off-chain decrypt.

## F15 — State machines mandatory for multi-phase contracts
Every phase-gated function needs onlyPhase modifier. Without it, out-of-order
calls corrupt encrypted state silently.

## F19 — Revealing one correlated value leaks the other
If totalVotesCast=10 and yesVotes=7 revealed, noVotes=3 is deduced.
Always reveal both correlated values atomically in the same transaction.

## F20 — Canonical FHE vote accumulation pattern
euint64 newYes = FHE.select(isSupport, FHE.add(yes, FHE.asEuint64(1)), yes);
euint64 newNo  = FHE.select(isSupport, no, FHE.add(no, FHE.asEuint64(1)));
Both counters always updated — select picks result. Cannot branch on ebool.

## F21 — Map each field to correct privacy level
Not everything needs encryption. hasVoted=public, voteDirection=encrypted.
Over-encrypting wastes gas. Under-encrypting leaks privacy.

## F22 — Extract multi-field lazy init to internal function
bool private _initialized;
function _init() internal {
  if (!_initialized) {
    _fieldA = FHE.asEuint64(0); FHE.allowThis(_fieldA);
    _fieldB = FHE.asEuint64(0); FHE.allowThis(_fieldB);
    _initialized = true;
  }
}

## F23 — ERC-7984 is NOT ERC-20 compatible
balanceOf→confidentialBalanceOf, transfer→confidentialTransfer(addr,bytes32,bytes),
approve→setOperator(addr,expiry), totalSupply→confidentialTotalSupply

## F25 — ERC-7984 required imports
npm install @openzeppelin/confidential-contracts @openzeppelin/contracts
import { ERC7984 } from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
Contract must inherit: ZamaEthereumConfig, ERC7984, Ownable2Step — in that order.

## F26 — NatSpec /** */ with @ symbols causes compile errors
@openzeppelin/... in /** */ block = invalid NatSpec tag = compile error.
Use // for all non-NatSpec comments including package names and install instructions.

## F28 — ERC-7984 constructor can use FHE via _mint() safely
Direct FHE calls in constructor still revert. But calling _mint(owner, FHE.asEuint64(n))
works because the FHE call executes inside _mint() not the constructor body directly.

## F30 — Multiple encrypted values share one inputProof — order matters
.add64(amount).add8(direction).encrypt() → handles[0]=amount, handles[1]=direction
Swapping handles passes wrong values silently — no error.
Contract param order must match the .addXX() call order exactly.

## F31 — externalEuint8 must be explicitly imported
Not included in default imports. Add to import list or get DeclarationError.

## F33 — ERC-20 + FHE hybrid pattern
Plaintext ERC-20 custody + encrypted order flow is valid and practical.
For full token privacy, use ERC-7984 instead of ERC-20.
Always add ReentrancyGuard to contracts holding ERC-20 tokens.

## F34 — All contracts in project must use same Solidity version
New contracts with ^0.8.28 fail if hardhat.config.ts specifies 0.8.24.
Keep all contracts and config in sync.
