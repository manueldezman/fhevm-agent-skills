# fhEVM Test Patterns
# Verified against @fhevm/hardhat-plugin (latest, May 2026)

## Correct imports
import { FhevmType } from "@fhevm/hardhat-plugin";
import { ethers, fhevm } from "hardhat";

## Encrypt in tests
fhevm.createEncryptedInput(addr, callerAddr).add64(n).encrypt()
Returns: { handles: string[], inputProof: Uint8Array }

## User decrypt in tests
fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddr, signer)
Returns: Promise<bigint>

## Public decrypt in tests
fhevm.publicDecryptEuint(FhevmType.euint64, handle, contractAddr)
Returns: Promise<bigint>

## Handle type
ethers returns euint64 handles as hex string — pass directly, do not convert

## Sequential ops
Always await tx.wait() between sequential FHE transactions

## Time advancement
await ethers.provider.send("evm_increaseTime", [seconds]);
await ethers.provider.send("evm_mine", []);
