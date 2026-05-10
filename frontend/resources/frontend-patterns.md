# fhEVM Frontend Patterns
# Verified against @zama-fhe/relayer-sdk 0.4.x

## Instance initialization
import from @zama-fhe/relayer-sdk/web
await initSDK()
createInstance({ ...SepoliaConfig, network: window.ethereum }) — Sepolia browser setup

## Encrypt
instance.createEncryptedInput(contractAddr, userAddr).add64(n).encrypt()
Returns: { handles: string[], inputProof: Uint8Array }
handles[0] = first encrypted value, handles[1] = second, etc.

## User decrypt (private)
instance.userDecrypt(handleContractPairs, privateKey, publicKey, signature, contractAddresses, userAddress, startTimestamp, durationDays)
Requires: signer must have ACL permission on the handle
Flow: generateKeypair(), createEIP712(), signer.signTypedData(), then userDecrypt()

## Public decrypt
instance.publicDecrypt([handle1, handle2]) → Promise<{ clearValues: Record<string, bigint> }>
Requires: handle must be marked FHE.makePubliclyDecryptable() on-chain
No signer needed — publicly decryptable

## Handle type
Contract view functions return euint64 as hex string from ethers
Do NOT convert — pass directly to userDecrypt/publicDecrypt

## ZeroHash check
if (handle === ethers.ZeroHash) return "0"; // uninitialized
