# FHEVM Agent Skills

Skill files for helping AI coding agents build, test, deploy, and integrate frontend dApps with Zama FHEVM.

## What is included

```text
fhevm-agent-skills/
├── smartcontract/
│   ├── SKILL.md
│   └── resources/
├── testing/
│   ├── SKILL.md
│   └── resources/
├── deployment/
│   ├── SKILL.md
│   └── resources/
└── frontend/
    ├── SKILL.md
    └── resources/
```

Each `SKILL.md` contains the core workflow and points to detailed examples in its local `resources/` folder.

## Install for Codex

Copy the collection into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills
cp -R fhevm-agent-skills ~/.codex/skills/
```

Expose each subskill as a top-level skill so Codex can discover it:

```bash
ln -sfn fhevm-agent-skills/smartcontract ~/.codex/skills/fhevm-smartcontract
ln -sfn fhevm-agent-skills/testing ~/.codex/skills/fhevm-testing
ln -sfn fhevm-agent-skills/deployment ~/.codex/skills/fhevm-deployment
ln -sfn fhevm-agent-skills/frontend ~/.codex/skills/fhevm-frontend
```

Restart Codex after installing so the skill metadata is reloaded.

## Install for Claude Code, Cursor, or Windsurf

Copy the relevant subskill folder into the agent's skill/rules/context location, preserving the `SKILL.md` and `resources/` folder together.

Use these mappings:

- Smart contract generation: `smartcontract/`
- Hardhat tests: `testing/`
- Sepolia/local deployment: `deployment/`
- Browser dApp integration: `frontend/`

If your coding agent does not support `SKILL.md` directly, add the body of the relevant `SKILL.md` as a project rule and keep the `resources/` files available in the repo for the agent to read on demand.

## Example prompts

```text
Use the FHEVM smart contract skill to write a private voting contract.
```

```text
Use the FHEVM testing skill to add Hardhat tests for encrypted inputs and user decryption.
```

```text
Use the FHEVM deployment skill to deploy ConfidentialDarkPool to Sepolia and save addresses for the frontend.
```

```text
Use the FHEVM frontend skill to build a browser UI that encrypts order inputs with the Zama Relayer SDK.
```

## Validation checklist

Before relying on the skills, run a real workflow:

```bash
npm run compile
npm run test
npx hardhat accounts --network sepolia
npx hardhat deploy --network sepolia
npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <contract-address>
```

For frontend validation, serve the frontend locally and confirm it loads the deployed addresses and initializes the Zama Relayer SDK on Sepolia.
