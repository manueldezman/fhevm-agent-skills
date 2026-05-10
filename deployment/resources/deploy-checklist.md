# fhEVM Deployment Checklist
# Follow in order — skip nothing

## Pre-deployment
[ ] npx hardhat compile — zero errors
[ ] npx hardhat test — all tests passing
[ ] npx hardhat vars list — MNEMONIC and INFURA_API_KEY present
[ ] INFURA_API_KEY is a Sepolia-enabled project id, not a `gas.api.infura.io` URL
[ ] npx hardhat accounts --network sepolia succeeds before deployment
[ ] If DNS fails with EAI_AGAIN in an agent sandbox, rerun the same command with network permission
[ ] Deployer wallet funded — check at https://sepolia.etherscan.io
[ ] Minimum 0.1 Sepolia ETH in deployer wallet

## Deploy
[ ] npx hardhat run scripts/deploy.ts --network sepolia
[ ] Contract address logged and saved to deployment.json
[ ] Transaction confirmed on https://sepolia.etherscan.io

## Post-deployment
[ ] npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <addr>
[ ] Contract verified: npx hardhat verify --network sepolia <addr> <args>
[ ] Deployed address added to frontend .env as VITE_CONTRACT_ADDRESS

## Sepolia faucets
https://sepoliafaucet.com
https://faucet.quicknode.com/ethereum/sepolia
https://www.alchemy.com/faucets/ethereum-sepolia
