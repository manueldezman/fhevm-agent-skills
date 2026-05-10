// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { FHE, externalEuint64, euint64 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { ERC7984 } from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

// ConfidentialToken — ERC-7984 confidential fungible token
//
// Inherits from:
//   ERC7984           — OpenZeppelin base confidential token
//   ZamaEthereumConfig — wires up ACL + gateway for target network
//   Ownable2Step      — two-step ownership transfer
//
// Install:
//   npm install @openzeppelin/confidential-contracts
//   npm install @openzeppelin/contracts
//
// Key differences from ERC-20:
//   balanceOf()     -> confidentialBalanceOf() returns euint64
//   transfer()      -> confidentialTransfer(address, bytes32, bytes)
//   approve()       -> setOperator(address, expiryTimestamp)
//   totalSupply()   -> confidentialTotalSupply() returns euint64
//
// Transfer is overloaded — use selector string in tests/frontend:
//   token["confidentialTransfer(address,bytes32,bytes)"](to, handle, proof)

contract ConfidentialToken is ZamaEthereumConfig, ERC7984, Ownable2Step {

    constructor(
        address initialOwner,
        uint64 initialSupply,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    )
        ERC7984(name_, symbol_, contractURI_)
        Ownable(initialOwner)
    {
        // FHE.asEuint64(literal) is valid here — called via _mint, not directly
        // in constructor body. This avoids the constructor FHE revert issue (F4).
        euint64 encryptedSupply = FHE.asEuint64(initialSupply);
        _mint(initialOwner, encryptedSupply);
    }

    // ── Mint ──────────────────────────────────────────────────────────────────

    // Visible mint — amount is public in calldata. Use for public emissions.
    function mint(address to, uint64 amount) external onlyOwner {
        _mint(to, FHE.asEuint64(amount));
    }

    // Confidential mint — amount stays encrypted. Use for private minting.
    // Client generates: fhevm.createEncryptedInput(addr, owner).add64(n).encrypt()
    function confidentialMint(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external onlyOwner returns (euint64 transferred) {
        return _mint(to, FHE.fromExternal(encryptedAmount, inputProof));
    }

    // ── Burn ──────────────────────────────────────────────────────────────────

    // Visible burn — amount is public.
    function burn(address from, uint64 amount) external onlyOwner {
        _burn(from, FHE.asEuint64(amount));
    }

    // Confidential burn — amount stays encrypted.
    function confidentialBurn(
        address from,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external onlyOwner returns (euint64 transferred) {
        return _burn(from, FHE.fromExternal(encryptedAmount, inputProof));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    // Owner opts into decrypting total supply.
    // By default even the owner cannot decrypt — must explicitly grant via FHE.allow.
    function grantOwnerSupplyAccess() external onlyOwner {
        FHE.allow(confidentialTotalSupply(), owner());
    }
}
