// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";

contract EscrowTest is Test {
    VerifierRegistry registry;
    Escrow escrow;

    // Verifier identity (private key + derived address)
    uint256 constant VERIFIER_PRIVKEY = 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;
    address VERIFIER; // computed from VERIFIER_PRIVKEY in setUp()

    // Other keys

    // Actors
    address constant BUYER  = address(0xB17e1E);  // funded in setUp()
    address constant SELLER = address(0x5e11e1);  // recipient

    // Receipt / trade fixtures (canonical France prompt values)
    bytes32 constant PSEC_VERSION = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    bytes32 constant MODEL_COMMITMENT = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 constant INPUT_HASH  = 0x05c0be0a90d620aaa058e271a2d96610aa364b818ddd48dd7db44a62b398ae4f;
    bytes32 constant OUTPUT_HASH = 0x6885e4e69b852f544e263d63bbdb73716a2524ba0e9abc69527ad6f4cef18aba;

    string  constant PROOF_FORMAT = "stub-v1";
    bytes32 constant TRADE_ID = keccak256("trade-001");

    uint256 constant TIER1_AMOUNT = 0.001 ether;
    uint256 constant TIER2_AMOUNT = 0.005 ether;

    bytes constant BUYER_PUBKEY  = hex"02cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    bytes constant CAROL_PUBKEY  = hex"03ababababababababababababababababababababababababababababababab00";

    // Recompute typehashes locally so any drift in the contract is caught
    bytes32 constant TIER1_TYPEHASH = keccak256(
        "Tier1Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier)"
    );
    bytes32 constant TIER2_TYPEHASH = keccak256(
        "Tier2Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier,bytes buyer_pubkey)"
    );

    function setUp() public {
        VERIFIER = vm.addr(VERIFIER_PRIVKEY);

        // Deploy registry, register stub-v1 -> VERIFIER
        registry = new VerifierRegistry();
        registry.register(PROOF_FORMAT, VERIFIER);

        // Deploy escrow
        escrow = new Escrow(address(registry));

        // Fund the buyer with enough ETH to open the trade
        vm.deal(BUYER, 10 ether);
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _signTier1(uint256 privkey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            TIER1_TYPEHASH, PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, uint8(1)
        ));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", escrow.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privkey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signTier2(uint256 privkey, bytes memory buyerPubkey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            TIER2_TYPEHASH, PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, uint8(2),
            keccak256(buyerPubkey)
        ));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", escrow.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privkey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openTrade() internal {
        vm.prank(BUYER);
        escrow.openTrade{value: TIER1_AMOUNT + TIER2_AMOUNT}(
            TRADE_ID, SELLER, TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, PROOF_FORMAT
        );
    }

    // ─── Test 1: Happy path — Tier 1 settles, funds flow ─────────────────

    function testHappyPath_Tier1Settles() public {
        _openTrade();
        assertEq(address(escrow).balance, TIER1_AMOUNT + TIER2_AMOUNT, "escrow holds full amount");
        assertEq(SELLER.balance, 0, "seller starts at 0");

        bytes memory sig = _signTier1(VERIFIER_PRIVKEY);
        escrow.settleTier1(TRADE_ID, sig);

        (bool t1, bool t2) = escrow.isSettled(TRADE_ID);
        assertTrue(t1, "tier1 settled flag");
        assertFalse(t2, "tier2 not yet settled");
        assertEq(SELLER.balance, TIER1_AMOUNT, "seller receives tier1 amount");
        assertEq(address(escrow).balance, TIER2_AMOUNT, "escrow retains tier2 amount");
    }

    function testHappyPath_BothTiersSettle() public {
        _openTrade();

        bytes memory sig1 = _signTier1(VERIFIER_PRIVKEY);
        escrow.settleTier1(TRADE_ID, sig1);

        bytes memory sig2 = _signTier2(VERIFIER_PRIVKEY, BUYER_PUBKEY);
        escrow.settleTier2(TRADE_ID, BUYER_PUBKEY, sig2);

        (bool t1, bool t2) = escrow.isSettled(TRADE_ID);
        assertTrue(t1 && t2, "both settled");
        assertEq(SELLER.balance, TIER1_AMOUNT + TIER2_AMOUNT, "seller has full amount");
        assertEq(address(escrow).balance, 0, "escrow drained");
    }

    // ─── Test 2: Wrong-signer rejection ──────────────────────────────────

    function testWrongSignerReverts() public {
        _openTrade();
        // Sign with a key that's NOT the registered verifier
        uint256 attackerKey = uint256(keccak256("attacker"));
        bytes memory badSig = _signTier1(attackerKey);

        vm.expectRevert(Escrow.WrongSigner.selector);
        escrow.settleTier1(TRADE_ID, badSig);
    }

    // ─── Test 3: Replay protection ───────────────────────────────────────

    function testReplayProtection_Tier1() public {
        _openTrade();
        bytes memory sig = _signTier1(VERIFIER_PRIVKEY);

        escrow.settleTier1(TRADE_ID, sig);

        vm.expectRevert(Escrow.AlreadySettled.selector);
        escrow.settleTier1(TRADE_ID, sig);
    }

    function testReplayProtection_Tier2() public {
        _openTrade();
        bytes memory sig = _signTier2(VERIFIER_PRIVKEY, BUYER_PUBKEY);

        escrow.settleTier2(TRADE_ID, BUYER_PUBKEY, sig);

        vm.expectRevert(Escrow.AlreadySettled.selector);
        escrow.settleTier2(TRADE_ID, BUYER_PUBKEY, sig);
    }

    // ─── Test 4: Tier 2 with mismatched buyer_pubkey (non-resale) ────────
    // This is the demo's pivotal beat. Verifier signs over Alice's pubkey.
    // Carol receives the receipt but submits Carol's pubkey to settle.
    // The contract's struct hash differs, recovery yields wrong address,
    // settlement reverts. Resale of provenance is structurally prevented.

    function testTier2_MismatchedBuyerPubkey_Reverts() public {
        _openTrade();
        // Verifier signed Tier 2 attestation with Alice's BUYER_PUBKEY
        bytes memory sig = _signTier2(VERIFIER_PRIVKEY, BUYER_PUBKEY);

        // Carol forwards the receipt + signature, but submits HER pubkey
        vm.expectRevert(Escrow.WrongSigner.selector);
        escrow.settleTier2(TRADE_ID, CAROL_PUBKEY, sig);
    }

    function testTier2_CorrectPubkeySucceeds() public {
        _openTrade();
        bytes memory sig = _signTier2(VERIFIER_PRIVKEY, BUYER_PUBKEY);
        escrow.settleTier2(TRADE_ID, BUYER_PUBKEY, sig);

        (, bool t2) = escrow.isSettled(TRADE_ID);
        assertTrue(t2);
    }

    // ─── Test 5: Funds correctness — exact amounts, no dust ──────────────

    function testFundsCorrectness_NoDust() public {
        _openTrade();

        bytes memory sig1 = _signTier1(VERIFIER_PRIVKEY);
        escrow.settleTier1(TRADE_ID, sig1);
        bytes memory sig2 = _signTier2(VERIFIER_PRIVKEY, BUYER_PUBKEY);
        escrow.settleTier2(TRADE_ID, BUYER_PUBKEY, sig2);

        // Exact accounting
        assertEq(SELLER.balance, TIER1_AMOUNT + TIER2_AMOUNT, "seller exact total");
        assertEq(address(escrow).balance, 0, "escrow has zero leftover");
    }

    // ─── Test 6: openTrade preconditions ─────────────────────────────────

    function testOpenTrade_WrongValueReverts() public {
        vm.prank(BUYER);
        vm.expectRevert(Escrow.WrongValue.selector);
        escrow.openTrade{value: TIER1_AMOUNT}(  // missing tier2_amount
            TRADE_ID, SELLER, TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, PROOF_FORMAT
        );
    }

    function testOpenTrade_DuplicateReverts() public {
        _openTrade();

        vm.deal(BUYER, 10 ether); // refund for the second attempt
        vm.prank(BUYER);
        vm.expectRevert(Escrow.TradeAlreadyExists.selector);
        escrow.openTrade{value: TIER1_AMOUNT + TIER2_AMOUNT}(
            TRADE_ID, SELLER, TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, PROOF_FORMAT
        );
    }

    function testOpenTrade_ZeroSellerReverts() public {
        vm.prank(BUYER);
        vm.expectRevert(Escrow.ZeroSeller.selector);
        escrow.openTrade{value: TIER1_AMOUNT + TIER2_AMOUNT}(
            TRADE_ID, address(0), TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, PROOF_FORMAT
        );
    }

    // ─── Test 7: Settling a nonexistent trade reverts ────────────────────

    function testSettleNonexistentTradeReverts() public {
        bytes memory sig = _signTier1(VERIFIER_PRIVKEY);
        vm.expectRevert(Escrow.TradeDoesNotExist.selector);
        escrow.settleTier1(keccak256("ghost-trade"), sig);
    }

    // ─── Test 8: Unregistered proof_format reverts ───────────────────────

    function testUnregisteredProofFormatReverts() public {
        // Open a trade with a proof_format the registry doesn't know
        vm.prank(BUYER);
        bytes32 ghostTrade = keccak256("ghost-format-trade");
        escrow.openTrade{value: TIER1_AMOUNT + TIER2_AMOUNT}(
            ghostTrade, SELLER, TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, "unknown-format-v1"
        );

        bytes memory sig = _signTier1(VERIFIER_PRIVKEY);
        vm.expectRevert(Escrow.VerifierNotRegistered.selector);
        escrow.settleTier1(ghostTrade, sig);
    }

    // ─── Test 9: Events emit correctly ───────────────────────────────────

    event TradeOpened(
        bytes32 indexed trade_id, address indexed buyer, address indexed seller,
        uint256 tier1_amount, uint256 tier2_amount, string proof_format
    );
    event Tier1Settled(bytes32 indexed trade_id, address indexed verifier, uint256 amount);
    event Tier2Settled(bytes32 indexed trade_id, address indexed verifier, bytes buyer_pubkey, uint256 amount);

    function testEvents_TradeOpened() public {
        vm.expectEmit(true, true, true, true);
        emit TradeOpened(TRADE_ID, BUYER, SELLER, TIER1_AMOUNT, TIER2_AMOUNT, PROOF_FORMAT);

        vm.prank(BUYER);
        escrow.openTrade{value: TIER1_AMOUNT + TIER2_AMOUNT}(
            TRADE_ID, SELLER, TIER1_AMOUNT, TIER2_AMOUNT,
            PSEC_VERSION, MODEL_COMMITMENT, INPUT_HASH, OUTPUT_HASH, PROOF_FORMAT
        );
    }

    function testEvents_Tier1Settled() public {
        _openTrade();
        bytes memory sig = _signTier1(VERIFIER_PRIVKEY);

        vm.expectEmit(true, true, false, true);
        emit Tier1Settled(TRADE_ID, VERIFIER, TIER1_AMOUNT);

        escrow.settleTier1(TRADE_ID, sig);
    }
}
