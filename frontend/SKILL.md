---
name: fhevm-frontend
description: >
  Use this skill when asked to integrate the Zama Relayer SDK, build a frontend for an
  FHEVM contract, connect a React app to a confidential smart contract,
  encrypt inputs in the browser, user decrypt encrypted values, public decrypt
  revealed values, implement EIP-712 signing for fhEVM, initialize a Relayer SDK
  instance, handle encrypted balances in UI, build a confidential token
  frontend, integrate MetaMask with fhEVM, or display decrypted results
  from an encrypted smart contract.
---

# fhEVM Frontend Skill

## What to do first

1. Read `resources/frontend-patterns.md` before writing any frontend code.

2. Install the current browser SDK:
   ```bash
   npm install @zama-fhe/relayer-sdk
   ```

3. Create `.env` with deployed contract address:
   ```
   VITE_CONTRACT_ADDRESS=0x...
   VITE_CHAIN_ID=11155111
   ```

4. Confirm the deployed contract address from `deployment.json` before wiring frontend.

---

## Resource map

- `resources/frontend-patterns.md` — reusable browser-side patterns for initializing the FHEVM frontend instance, encrypted input creation, user decrypt, public decrypt, handle handling, and ZeroHash checks.

---

## Relayer SDK instance initialization

```typescript
import { createInstance, initSDK, SepoliaConfig, FhevmInstance } from "@zama-fhe/relayer-sdk/web";

async function initFhevm(): Promise<FhevmInstance> {
  await initSDK();
  return createInstance({ ...SepoliaConfig, network: window.ethereum });
}

// In React — initialize once on mount
const [instance, setInstance] = useState<FhevmInstance | null>(null);

useEffect(() => {
  initFhevm().then(setInstance);
}, []);
```

---

## Encrypting inputs — browser side

```typescript
// Single value
async function encryptUint64(
  value: bigint,
  contractAddress: string,
  userAddress: string
) {
  const input = await instance.createEncryptedInput(contractAddress, userAddress);
  input.add64(value);
  return input.encrypt(); // returns { handles, inputProof }
}

// Boolean vote
async function encryptBool(
  value: boolean,
  contractAddress: string,
  userAddress: string
) {
  const input = await instance.createEncryptedInput(contractAddress, userAddress);
  input.addBool(value);
  return input.encrypt();
}

// Multiple values — shared proof
async function encryptOrder(amount: bigint, direction: number) {
  const input = await instance.createEncryptedInput(contractAddress, userAddress);
  input.add64(amount);   // handles[0]
  input.add8(direction); // handles[1]
  return input.encrypt();
}
```

---

## User decryption — EIP-712 signing flow

```typescript
// Private value — only ACL-permitted address can decrypt
async function userDecrypt(
  handle: string,          // hex string from contract view function
  contractAddress: string,
  signer: any              // ethers signer with ACL permission
): Promise<bigint> {
  const keypair = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 7;
  const eip712 = instance.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, durationDays);
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );
  const clear = await instance.userDecrypt(
    [{ handle, contractAddress }],
    keypair.privateKey,
    keypair.publicKey,
    signature,
    [contractAddress],
    await signer.getAddress(),
    startTimestamp,
    durationDays,
  );
  return clear[handle] as bigint;
}

// Usage
const handle = await contract.getBalance();  // returns hex string
const balance = await userDecrypt(handle, CONTRACT_ADDRESS, signer);
console.log(balance.toString()); // BigInt
```

---

## Public decryption

```typescript
// Publicly decryptable handle — marked by FHE.makePubliclyDecryptable() on-chain
async function publicDecrypt(handles: string[]): Promise<Record<string, bigint>> {
  const results = await instance.publicDecrypt(handles);
  return results.clearValues; // { [handle]: bigint }
}

// Usage
const yesHandle = await contract.publicYesHandle();
const noHandle  = await contract.publicNoHandle();
const results   = await instance.publicDecrypt([yesHandle, noHandle]);
const yesVotes  = results.clearValues[yesHandle];
const noVotes   = results.clearValues[noHandle];
```

---

## React hook pattern

```typescript
import { createInstance, initSDK, SepoliaConfig, FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { useRef, useState, useEffect } from "react";
import { BrowserProvider } from "ethers";

export function useFhevm(contractAddress: string) {
  const instanceRef = useRef<FhevmInstance | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      await initSDK();
      instanceRef.current = await createInstance({ ...SepoliaConfig, network: window.ethereum });
      setReady(true);
    }
    init();
  }, []);

  async function encryptUint64(value: bigint, userAddress: string) {
    const input = await instanceRef.current!
      .createEncryptedInput(contractAddress, userAddress);
    input.add64(value);
    return input.encrypt();
  }

  async function encryptBool(value: boolean, userAddress: string) {
    const input = await instanceRef.current!
      .createEncryptedInput(contractAddress, userAddress);
    input.addBool(value);
    return input.encrypt();
  }

  async function userDecrypt(handle: string, signer: any): Promise<bigint> {
    const keypair = instanceRef.current!.generateKeypair();
    const startTimestamp = Math.floor(Date.now() / 1000);
    const durationDays = 7;
    const eip712 = instanceRef.current!.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, durationDays);
    const signature = await signer.signTypedData(
      eip712.domain,
      { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
      eip712.message,
    );
    const clear = await instanceRef.current!.userDecrypt(
      [{ handle, contractAddress }],
      keypair.privateKey,
      keypair.publicKey,
      signature,
      [contractAddress],
      await signer.getAddress(),
      startTimestamp,
      durationDays,
    );
    return clear[handle] as bigint;
  }

  async function publicDecrypt(handles: string[]): Promise<Record<string, bigint>> {
    const results = await instanceRef.current!.publicDecrypt(handles);
    return results.clearValues;
  }

  return { ready, encryptUint64, encryptBool, userDecrypt, publicDecrypt };
}
```

---

## Displaying encrypted values

```typescript
async function displayBalance(contract: any, instance: FhevmInstance, signer: any) {
  const handle = await contract.getBalance();

  // Check if uninitialized
  if (handle === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    return "0";
  }

  const clearBalance = await instance.userDecrypt(
    handle,
    contract.target,
    signer
  );

  return ethers.formatUnits(clearBalance, 18);
}
```

---

## Calling contract functions with encrypted inputs

```typescript
import { ethers, BrowserProvider, Contract } from "ethers";

async function deposit(amount: bigint) {
  const provider = new BrowserProvider(window.ethereum);
  const signer   = await provider.getSigner();
  const userAddr = await signer.getAddress();

  const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);

  const { handles, inputProof } = await encryptUint64(amount, userAddr);
  const tx = await contract.deposit(handles[0], inputProof);
  await tx.wait();
}
```

---

## Network configuration

```
Hardhat local   chainId: 31337   → mock, no real fhEVM
Sepolia testnet chainId: 11155111 → real fhEVM coprocessors
```

```typescript
// Check network before initializing
const chainId = await window.ethereum.request({ method: "eth_chainId" });
if (parseInt(chainId, 16) !== 11155111) {
  alert("Please switch to Sepolia testnet");
  return;
}
```

---

## Findings

<!-- To be populated after frontend validation against deployed Sepolia contract -->

---

## Anti-patterns

```typescript
// AP-F001: Using Relayer SDK browser APIs in Node.js / Hardhat scripts
// Relayer SDK browser APIs are for frontends — use @fhevm/hardhat-plugin in tests
import { createInstance } from "@zama-fhe/relayer-sdk/web"; // in hardhat test → wrong
// Fix: use fhevm from "hardhat" in tests

// AP-F002: Not waiting for instance to initialize before encrypting
const { handles } = await fhevm.encryptUint64(1000n); // instance null → crash
// Fix: check ready state before any encrypt/decrypt operation

// AP-F003: Hardcoding contract address in component
const CONTRACT = "0xabc..."; // breaks on redeploy
// Fix: use environment variable VITE_CONTRACT_ADDRESS

// AP-F004: Displaying encrypted handle as balance
const balance = await contract.getBalance();
setBalance(balance.toString()); // shows hex handle not plaintext
// Fix: run the full generateKeypair + EIP-712 + userDecrypt flow first, then display

// AP-F005: Not handling ZeroHash (uninitialized handle)
const balance = await userDecrypt(handle, addr, signer); // crashes on ZeroHash
// Fix: check handle !== ethers.ZeroHash before decrypting

// AP-F006: Wrong public decrypt API
const result = await instance.publicDecrypt(handle); // handle not array
// Fix: await instance.publicDecrypt([handle]) — always pass array
```

---

## Validation checklist

```
[ ] Relayer SDK installed: npm install @zama-fhe/relayer-sdk
[ ] CONTRACT_ADDRESS in .env matches deployed Sepolia address
[ ] Relayer SDK initialized with initSDK() and createInstance({ ...SepoliaConfig, network: window.ethereum })
[ ] Network check: user is on correct chain before any FHE operation
[ ] Encrypt uses instance.createEncryptedInput(contractAddr, userAddr)
[ ] User decrypt: generateKeypair(), createEIP712(), signTypedData(), then instance.userDecrypt(...)
[ ] Public decrypt: instance.publicDecrypt([handle1, handle2])
[ ] ZeroHash check before decrypting uninitialized handles
[ ] BigInt displayed as string (balance.toString() or formatUnits)
[ ] tx.wait() called after every contract write transaction
[ ] Error handling for ACL failures (user lacks permission)
[ ] Loading states during async encrypt/decrypt operations
```
