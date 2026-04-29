// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VerifierRegistry} from "./VerifierRegistry.sol";

/**
 * @title Escrow
 * @notice Holds buyer funds until a verifier signs a Tier1/Tier2 attestation.
 *
 * Lifecycle:
 *   1. Buyer calls openTrade(trade_id, ..., proof_format) with msg.value =
 *      tier1_amount + tier2_amount. Funds are held by this contract.
 *   2. Verifier service (e.g. verifier-stub on :7002) signs an EIP-712
 *      Tier1Attestation over the receipt's hashes.
 *   3. Anyone calls settleTier1(trade_id, signature). Contract recovers the
 *      signer, looks up the registered verifier for the trade's proof_format,
 *      reverts if mismatch, otherwise releases tier1_amount to the seller.
 *   4. For evidentiary buys, verifier signs a Tier2Attestation including the
 *      buyer's pubkey. Buyer calls settleTier2(trade_id, buyer_pubkey, sig).
 *      Contract recovers, validates buyer_pubkey is the one signed, releases
 *      tier2_amount. The bound buyer_pubkey is what makes the receipt
 *      non-resaleable: forwarding the receipt to a different identity fails
 *      verification because that identity's pubkey isn't in the digest.
 *
 * EIP-712 domain:
 *   name: "DeFacts", version: "1", chainId: block.chainid,
 *   verifyingContract: address(this)
 *
 * The verifier-stub is configured with verifyingContract = ESCROW_ADDR matching
 * this contract's deployment address. Mismatched domain = mismatched digest =
 * recovery returns wrong address = settlement reverts.
 *
 * Security:
 *   - ReentrancyGuard on settle paths (defense-in-depth; checks-effects-
 *     interactions ordering already prevents double-settle, but cheap insurance)
 *   - Replay protection via t.settled_tier1 / t.settled_tier2 flags
 *   - Funds correctness: tier1_amount goes to seller on Tier 1 settle,
 *     tier2_amount on Tier 2; no leftover dust possible per the openTrade
 *     msg.value invariant
 */
contract Escrow is ReentrancyGuard {
    // ─── EIP-712 typehashes (must byte-match verifier-stub's tier1Types/tier2Types) ──

    bytes32 public constant TIER1_TYPEHASH = keccak256(
        "Tier1Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier)"
    );

    bytes32 public constant TIER2_TYPEHASH = keccak256(
        "Tier2Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier,bytes buyer_pubkey)"
    );

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;
    VerifierRegistry public immutable registry;

    // ─── Trade state ─────────────────────────────────────────────────────

    struct Trade {
        address buyer;
        address seller;
        uint256 tier1_amount;
        uint256 tier2_amount;
        bytes32 psec_version;
        bytes32 model_commitment;
        bytes32 input_hash;
        bytes32 output_hash;
        bool settled_tier1;
        bool settled_tier2;
        string proof_format;
    }

    mapping(bytes32 => Trade) public trades;

    // ─── Events ──────────────────────────────────────────────────────────

    event TradeOpened(
        bytes32 indexed trade_id,
        address indexed buyer,
        address indexed seller,
        uint256 tier1_amount,
        uint256 tier2_amount,
        string proof_format
    );

    event Tier1Settled(bytes32 indexed trade_id, address indexed verifier, uint256 amount);
    event Tier2Settled(bytes32 indexed trade_id, address indexed verifier, bytes buyer_pubkey, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────

    error TradeAlreadyExists();
    error TradeDoesNotExist();
    error WrongValue();
    error AlreadySettled();
    error VerifierNotRegistered();
    error WrongSigner();
    error TransferFailed();
    error ZeroSeller();

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor(address registry_addr) {
        registry = VerifierRegistry(registry_addr);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("DeFacts")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── Open trade ──────────────────────────────────────────────────────

    function openTrade(
        bytes32 trade_id,
        address seller,
        uint256 tier1_amount,
        uint256 tier2_amount,
        bytes32 psec_version,
        bytes32 model_commitment,
        bytes32 input_hash,
        bytes32 output_hash,
        string calldata proof_format
    ) external payable {
        if (trades[trade_id].buyer != address(0)) revert TradeAlreadyExists();
        if (msg.value != tier1_amount + tier2_amount) revert WrongValue();
        if (seller == address(0)) revert ZeroSeller();

        trades[trade_id] = Trade({
            buyer: msg.sender,
            seller: seller,
            tier1_amount: tier1_amount,
            tier2_amount: tier2_amount,
            psec_version: psec_version,
            model_commitment: model_commitment,
            input_hash: input_hash,
            output_hash: output_hash,
            settled_tier1: false,
            settled_tier2: false,
            proof_format: proof_format
        });

        emit TradeOpened(trade_id, msg.sender, seller, tier1_amount, tier2_amount, proof_format);
    }

    // ─── Settle Tier 1 ───────────────────────────────────────────────────

    function settleTier1(bytes32 trade_id, bytes calldata signature) external nonReentrant {
        Trade storage t = trades[trade_id];
        if (t.buyer == address(0)) revert TradeDoesNotExist();
        if (t.settled_tier1) revert AlreadySettled();

        bytes32 structHash = keccak256(
            abi.encode(
                TIER1_TYPEHASH,
                t.psec_version,
                t.model_commitment,
                t.input_hash,
                t.output_hash,
                uint8(1)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
        address recovered = ECDSA.recover(digest, signature);

        address registered = registry.getVerifier(t.proof_format);
        if (registered == address(0)) revert VerifierNotRegistered();
        if (recovered != registered) revert WrongSigner();

        t.settled_tier1 = true;
        uint256 amount = t.tier1_amount;
        emit Tier1Settled(trade_id, recovered, amount);

        (bool ok, ) = t.seller.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ─── Settle Tier 2 ───────────────────────────────────────────────────

    function settleTier2(
        bytes32 trade_id,
        bytes calldata buyer_pubkey,
        bytes calldata signature
    ) external nonReentrant {
        Trade storage t = trades[trade_id];
        if (t.buyer == address(0)) revert TradeDoesNotExist();
        if (t.settled_tier2) revert AlreadySettled();

        // Tier 2 includes buyer_pubkey as a `bytes` field, which per EIP-712
        // requires keccak256(buyer_pubkey) substituted in the struct hash.
        // viem does this automatically; we do it explicitly here.
        bytes32 structHash = keccak256(
            abi.encode(
                TIER2_TYPEHASH,
                t.psec_version,
                t.model_commitment,
                t.input_hash,
                t.output_hash,
                uint8(2),
                keccak256(buyer_pubkey)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
        address recovered = ECDSA.recover(digest, signature);

        address registered = registry.getVerifier(t.proof_format);
        if (registered == address(0)) revert VerifierNotRegistered();
        if (recovered != registered) revert WrongSigner();

        t.settled_tier2 = true;
        uint256 amount = t.tier2_amount;
        emit Tier2Settled(trade_id, recovered, buyer_pubkey, amount);

        (bool ok, ) = t.seller.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ─── View helpers ────────────────────────────────────────────────────

    function isSettled(bytes32 trade_id) external view returns (bool tier1, bool tier2) {
        Trade storage t = trades[trade_id];
        return (t.settled_tier1, t.settled_tier2);
    }
}
