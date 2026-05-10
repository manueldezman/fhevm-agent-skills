---
name: fhevm-deployment
description: >
  Use this skill when asked to deploy an FHEVM contract, deploy to Sepolia,
  configure hardhat for fhEVM deployment, set up MNEMONIC or INFURA_API_KEY,
  use hardhat vars, verify a contract on Etherscan, check fhEVM compatibility,
  deploy a confidential smart contract to testnet, or set up environment
  variables for Zama Protocol deployment.
---

# fhEVM Deployment Skill

## What to do first

1. Read `resources/deploy-checklist.md` before running any deployment.

2. Confirm environment variables are set:
   ```bash
   npx hardhat vars list
   ```
   Required vars: `MNEMONIC`, `INFURA_API_KEY` (or `ALCHEMY_API_KEY`)

3. Set vars if missing. For Infura, store the project id only, not a gas API URL:
   ```bash
   npx hardhat vars set MNEMONIC
   npx hardhat vars set INFURA_API_KEY
   ```
   The Sepolia RPC URL must be `https://sepolia.infura.io/v3/<project-id>`. A URL like `https://gas.api.infura.io/v3/<project-id>` is not an Ethereum JSON-RPC endpoint.

4. Preflight the RPC and deployer balance before deploying:
   ```bash
   npx hardhat accounts --network sepolia
   ```
   If Infura returns “project ID does not have access to this network,” enable Sepolia/Ethereum JSON-RPC access for the project id or use a different RPC provider.

5. Get Sepolia ETH:
   - https://sepoliafaucet.com
   - https://faucet.quicknode.com/ethereum/sepolia
   - Minimum: 0.1 ETH for deployment + test transactions

---

## Resource map

- `resources/deploy-checklist.md` — deployment checklist covering pre-deploy checks, Sepolia deploy, compatibility check, verification, frontend address handoff, and faucets.

---

## hardhat.config.ts — confirmed working config

```typescript
import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

const MNEMONIC       = vars.get("MNEMONIC", "test test test test test test test test test test test junk");
const INFURA_API_KEY = vars.get("INFURA_API_KEY", "");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      accounts: { mnemonic: MNEMONIC, count: 10 },
      chainId: 11155111,
    },
  },
};

export default config;
```

---

## Deploy script pattern

```typescript
// scripts/deploy.ts
import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(
    await ethers.provider.getBalance(deployer.address)
  ), "ETH");

  const Contract = await ethers.getContractFactory("MyContract");
  const contract = await Contract.deploy(/* constructor args */);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("Deployed to:", address);

  // Save address for frontend
  fs.writeFileSync("deployment.json", JSON.stringify({
    address,
    network: "sepolia",
    chainId: 11155111,
    deployedAt: new Date().toISOString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

---

## Deployment commands

```bash
# Compile first — always
npx hardhat compile

# Deploy to Sepolia
npx hardhat accounts --network sepolia
npx hardhat run scripts/deploy.ts --network sepolia

# Check fhEVM compatibility after deploy
npx hardhat fhevm check-fhevm-compatibility \
  --network sepolia \
  --address <deployed-contract-address>

# Verify on Etherscan (requires ETHERSCAN_API_KEY)
npx hardhat verify --network sepolia <address> <constructor-arg-1> <constructor-arg-2>
```

---

## Etherscan verification setup

```typescript
// hardhat.config.ts — add etherscan config
import "@nomicfoundation/hardhat-verify";

const config: HardhatUserConfig = {
  // ... existing config ...
  etherscan: {
    apiKey: {
      sepolia: vars.get("ETHERSCAN_API_KEY", ""),
    },
  },
};
```

```bash
npx hardhat vars set ETHERSCAN_API_KEY
npx hardhat verify --network sepolia <address> <args>
```

---

## ZamaConfig — network-specific addresses

`ZamaEthereumConfig` automatically configures ACL and gateway addresses per network:

```
Sepolia (11155111)  → ACL + gateway auto-configured by ZamaEthereumConfig
Hardhat (31337)     → mock mode, no real coprocessors
Localhost (31337)   → mock mode, persistent state
```

Do NOT manually set ACL or gateway addresses — `ZamaEthereumConfig` handles this.

---

## Findings

<!-- To be populated after Sepolia deployment validation -->

- D1: Infura gas API URLs are not Sepolia RPC URLs. Use `https://sepolia.infura.io/v3/<project-id>` via `INFURA_API_KEY`.
- D2: A valid-looking Infura project id can still fail with `project ID does not have access to this network`; run `npx hardhat accounts --network sepolia` before deployment.
- D3: Sepolia deployment validation sequence that worked: set `MNEMONIC`, set a Sepolia-enabled `INFURA_API_KEY`, run `npx hardhat accounts --network sepolia`, run `npx hardhat deploy --network sepolia`, then run `npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <ConfidentialDarkPool>`.
- D4: In sandboxed agent environments, Sepolia commands may fail with transient DNS errors such as `getaddrinfo EAI_AGAIN sepolia.infura.io`; rerun the same command with network permission instead of changing contract code.

---

## Anti-patterns

```bash
# AP-D001: Deploying without compiling first
npx hardhat run scripts/deploy.ts --network sepolia  # may use stale artifacts
# Fix: npx hardhat compile && npx hardhat run scripts/deploy.ts --network sepolia

# AP-D002: Hardcoding private key in config
accounts: ["0xabc123..."]  # exposed in git history
# Fix: use hardhat vars — npx hardhat vars set MNEMONIC

# AP-D003: Not checking fhEVM compatibility after deploy
# Silent failures on Sepolia if contract uses unsupported ops
# Fix: always run check-fhevm-compatibility after every deploy

# AP-D004: Not saving deployed address
# Frontend and tests need the address — write to deployment.json
# Fix: fs.writeFileSync("deployment.json", JSON.stringify({ address }))

# AP-D005: Using mock-only patterns on Sepolia
# fhevm plugin (createEncryptedInput, userDecryptEuint) works in tests only
# Use @zama-fhe/relayer-sdk in the frontend for Sepolia interactions
```

---

## Validation checklist

```
[ ] npx hardhat vars list shows MNEMONIC and INFURA_API_KEY
[ ] npx hardhat accounts --network sepolia prints funded deployer accounts
[ ] Deployer wallet has at least 0.1 Sepolia ETH
[ ] npx hardhat compile completes with no errors
[ ] hardhat.config.ts has solidity 0.8.28 + evmVersion cancun
[ ] Deploy script saves address to deployment.json
[ ] npx hardhat run scripts/deploy.ts --network sepolia succeeds
[ ] fhevm check-fhevm-compatibility passes on deployed address
[ ] Contract verified on Sepolia Etherscan
[ ] Deployed address copied to frontend .env file
```
