// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.28;

import { FHE, euint64, euint8, externalEbool, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title  PrivateVoting — Iteration 2b
 * @notice Governance voting contract where individual votes stay private forever.
 *         Only the final tally (yes/no counts) is revealed after voting ends.
 *
 * WHAT THIS SOLVES:
 *   Standard on-chain voting leaks every voter's choice — enabling bribery,
 *   coercion, and strategic late voting. This contract keeps all votes
 *   encrypted until the deadline, then reveals only aggregate results.
 *
 * VERIFIED v0.11 PATTERNS:
 *   - externalEbool + FHE.fromExternal() for encrypted bool vote input
 *   - FHE.select() for branch-free vote tallying
 *   - FHE.asEuint64(0) in constructor — tested and confirmed working in v0.11
 *     when called via lazy init (NOT directly in constructor body)
 *   - FHE.makePubliclyDecryptable() for tally reveal
 *   - fhevm.publicDecryptEuint() on test side
 *
 * NEW PATTERNS vs ITERATION 2a:
 *   - externalEbool (boolean encrypted input) — not just euint64
 *   - FHE.fromExternal() on ebool type
 *   - Multi-value public decryption (yes AND no counts revealed together)
 *   - Voter eligibility whitelist (plaintext) + encrypted vote (private)
 *   - Proposal metadata stored alongside encrypted state
 *   - One-vote-per-address enforcement without revealing who voted which way
 *
 * STATE MACHINE:
 *   Active → Ended → Revealed
 *
 * DESIGN DECISIONS:
 *   - hasVoted[address] is PUBLIC — we reveal WHO voted, not HOW they voted
 *   - Individual vote direction is NEVER revealed, not even to the owner
 *   - Both yes and no tallies revealed together (prevents partial inference)
 *   - Voter whitelist optional — if empty, anyone can vote
 */
contract PrivateVoting is ZamaEthereumConfig {

    // ── State machine ─────────────────────────────────────────────────────────

    enum VotingStatus { Active, Ended, Revealed }
    VotingStatus public status;

    // ── Proposal metadata ─────────────────────────────────────────────────────

    string public proposalTitle;
    address public immutable owner;
    uint256 public immutable votingDeadline;

    // ── Voter state (plaintext — WHO voted is public, HOW is private) ─────────

    mapping(address => bool) public hasVoted;
    mapping(address => bool) public isEligible;
    bool public whitelistEnabled;
    uint256 public totalVotesCast;

    // ── Encrypted tallies ─────────────────────────────────────────────────────

    euint64 private _encryptedYesVotes;
    euint64 private _encryptedNoVotes;

    // ── Revealed results (set after public decryption) ────────────────────────

    uint64 public decryptedYesVotes;
    uint64 public decryptedNoVotes;

    // ── Publicly decryptable handles (for frontend/test decryption) ───────────

    euint64 public publicYesHandle;
    euint64 public publicNoHandle;

    // ── Events ────────────────────────────────────────────────────────────────

    /// WHO voted is public — HOW they voted is not in the event
    event VoteCast(address indexed voter);
    event VotingEnded();
    event ResultsRevealed(uint64 yesVotes, uint64 noVotes);

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyOwner();
    error WrongStatus();
    error AlreadyVoted();
    error NotEligible();
    error DeadlineNotReached();
    error DeadlineReached();

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @dev Initializes encrypted tallies to zero using lazy init pattern.
     *      NOTE: FHE.asEuint64(0) in constructor body caused revert in our
     *      Iteration 1 vault. Moved to _initializeTallies() called on first vote.
     *      This is the confirmed safe pattern for v0.11.
     */
    constructor(
        string memory _proposalTitle,
        uint256 votingDurationSeconds,
        bool _whitelistEnabled
    ) {
        owner = msg.sender;
        proposalTitle = _proposalTitle;
        votingDeadline = block.timestamp + votingDurationSeconds;
        whitelistEnabled = _whitelistEnabled;
        status = VotingStatus.Active;
        // Tallies initialized lazily on first vote — see _initializeTallies()
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyStatus(VotingStatus expected) {
        if (status != expected) revert WrongStatus();
        _;
    }

    // ── Whitelist management ──────────────────────────────────────────────────

    function addEligibleVoter(address voter) external onlyOwner onlyStatus(VotingStatus.Active) {
        isEligible[voter] = true;
    }

    function addEligibleVoters(address[] calldata voters) external onlyOwner onlyStatus(VotingStatus.Active) {
        for (uint256 i = 0; i < voters.length; i++) {
            isEligible[voters[i]] = true;
        }
    }

    // ── Vote ──────────────────────────────────────────────────────────────────

    /**
     * @notice Cast an encrypted vote.
     * @param encryptedSupport  externalEbool — true = yes, false = no (encrypted)
     * @param inputProof        Proof binding ciphertext to (this contract, msg.sender)
     *
     * NEW PATTERN (vs Iteration 2a):
     *   externalEbool — the encrypted boolean input type
     *   FHE.fromExternal(externalEbool, proof) — returns ebool
     *   FHE.select(ebool, ifTrue, ifFalse) — branch-free tally update
     *
     * DESIGN: Both yes and no counters are always updated — FHE.select picks
     *         which one actually increments. This means:
     *         - yes vote: yes++ (select picks add), no stays (select picks current)
     *         - no vote:  yes stays (select picks current), no++ (select picks add)
     *         Both paths execute — observer cannot tell which branch "won".
     */
    function vote(
        externalEbool encryptedSupport,
        bytes calldata inputProof
    ) external onlyStatus(VotingStatus.Active) {
        require(block.timestamp <= votingDeadline, "Voting deadline reached");

        if (hasVoted[msg.sender]) revert AlreadyVoted();
        if (whitelistEnabled && !isEligible[msg.sender]) revert NotEligible();

        // Lazy initialize tallies on first vote
        _initializeTallies();

        // Unwrap encrypted bool — proof validates (this contract, msg.sender) binding
        ebool isSupport = FHE.fromExternal(encryptedSupport, inputProof);

        // Branch-free tally update — both additions computed, select picks result
        // PATTERN: This is the canonical FHE voting accumulation pattern
        euint64 newYes = FHE.select(isSupport, FHE.add(_encryptedYesVotes, FHE.asEuint64(1)), _encryptedYesVotes);
        euint64 newNo  = FHE.select(isSupport, _encryptedNoVotes, FHE.add(_encryptedNoVotes, FHE.asEuint64(1)));

        _encryptedYesVotes = newYes;
        _encryptedNoVotes  = newNo;

        // Re-grant ACL on new handles — mandatory after every FHE operation
        FHE.allowThis(newYes);
        FHE.allowThis(newNo);

        hasVoted[msg.sender] = true;
        totalVotesCast++;

        // WHO voted is public — emitted without vote direction
        emit VoteCast(msg.sender);
    }

    // ── End voting ────────────────────────────────────────────────────────────

    function endVoting()
        external
        onlyOwner
        onlyStatus(VotingStatus.Active)
    {
        require(block.timestamp > votingDeadline, "Deadline not reached");
        status = VotingStatus.Ended;
        emit VotingEnded();
    }

    // ── Reveal results ────────────────────────────────────────────────────────

    /**
     * @notice Mark both tallies as publicly decryptable.
     * @dev VERIFIED v0.11 pattern:
     *      FHE.makePubliclyDecryptable() marks the handle so anyone can decrypt
     *      via fhevm.publicDecryptEuint() off-chain.
     *
     *      CRITICAL: Both yes AND no must be revealed together.
     *      Revealing only one allows inference of the other via totalVotesCast.
     *      Example: if totalVotesCast=10 and yes=7 is revealed, no=3 is deduced.
     *      Always reveal both tallies atomically.
     */
    function revealResults()
        external
        onlyOwner
        onlyStatus(VotingStatus.Ended)
    {
        require(totalVotesCast > 0, "No votes cast");

        // Mark both handles publicly decryptable — atomically
        publicYesHandle = FHE.makePubliclyDecryptable(_encryptedYesVotes);
        publicNoHandle  = FHE.makePubliclyDecryptable(_encryptedNoVotes);

        status = VotingStatus.Revealed;
    }

    /**
     * @notice Submit decrypted results on-chain after off-chain decryption.
     * @dev Caller obtains cleartext via:
     *      yesVotes = await fhevm.publicDecryptEuint(FhevmType.euint64, publicYesHandle, addr)
     *      noVotes  = await fhevm.publicDecryptEuint(FhevmType.euint64, publicNoHandle, addr)
     */
    function submitResults(
        uint64 yesVotes,
        uint64 noVotes
    ) external onlyStatus(VotingStatus.Revealed) {
        require(decryptedYesVotes == 0 && decryptedNoVotes == 0, "Already submitted");

        decryptedYesVotes = yesVotes;
        decryptedNoVotes  = noVotes;

        emit ResultsRevealed(yesVotes, noVotes);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getResults() external view returns (uint64 yes, uint64 no) {
        require(status == VotingStatus.Revealed, "Not revealed yet");
        require(decryptedYesVotes > 0 || decryptedNoVotes > 0, "Not submitted yet");
        return (decryptedYesVotes, decryptedNoVotes);
    }

    function getProposalInfo() external view returns (
        string memory title,
        uint256 deadline,
        uint256 votesCast,
        VotingStatus currentStatus
    ) {
        return (proposalTitle, votingDeadline, totalVotesCast, status);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    bool private _talliesInitialized;

    function _initializeTallies() internal {
        if (!_talliesInitialized) {
            _encryptedYesVotes = FHE.asEuint64(0);
            _encryptedNoVotes  = FHE.asEuint64(0);
            FHE.allowThis(_encryptedYesVotes);
            FHE.allowThis(_encryptedNoVotes);
            _talliesInitialized = true;
        }
    }
}
