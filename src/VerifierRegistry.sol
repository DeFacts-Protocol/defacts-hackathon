// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title VerifierRegistry
 * @notice Maps proof_format strings to verifier service addresses.
 *
 * Receipts produced by suppliers carry a `proof_format` field
 * (e.g. "stub-v1", "pd19-v1", "ezkl-v1"). When Escrow.sol settles a trade,
 * it consults this registry to find the canonical verifier for that proof_format
 * and recovers the EIP-712 signature against that address. The signature must
 * recover to exactly the registered verifier, otherwise settlement reverts.
 *
 * For the hackathon the registry is owner-gated. Production will be
 * governance-managed (ENS-anchored or a multisig).
 *
 * Invariants:
 *   - Only the owner can register/update a proof_format → address mapping.
 *   - Anyone can read the mapping (verifier addresses are public).
 *   - Re-registering a proof_format updates the verifier (supports rotation).
 *   - Registering address(0) is allowed and effectively de-registers a format.
 */
contract VerifierRegistry {
    address public immutable owner;
    mapping(string => address) private _verifiers;

    event VerifierRegistered(string indexed proof_format, address indexed verifier);

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @notice Register or update the verifier for a given proof_format.
     * @param proof_format e.g. "stub-v1", "pd19-v1"
     * @param verifier secp256k1 address that signs EIP-712 attestations for this format
     */
    function register(string calldata proof_format, address verifier) external onlyOwner {
        _verifiers[proof_format] = verifier;
        emit VerifierRegistered(proof_format, verifier);
    }

    /**
     * @notice Look up the verifier for a given proof_format.
     * @return verifier the registered address, or address(0) if unregistered
     */
    function getVerifier(string calldata proof_format) external view returns (address verifier) {
        return _verifiers[proof_format];
    }
}
