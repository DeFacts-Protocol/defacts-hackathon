// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract EIP712CrossCheck is Test {
    bytes32 constant TIER1_TYPEHASH = keccak256(
        "Tier1Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier)"
    );
    bytes32 constant TIER2_TYPEHASH = keccak256(
        "Tier2Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier,bytes buyer_pubkey)"
    );
    bytes32 constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    string fixtures;

    function setUp() public {
        fixtures = vm.readFile("./test/eip712-cross-check/fixtures.json");
    }

    function testTier1TypeHashMatches() public {
        bytes32 expected = vm.parseJsonBytes32(fixtures, ".tier1.typeHash");
        assertEq(TIER1_TYPEHASH, expected, "TIER1_TYPEHASH disagreement");
    }

    function testTier1DomainSeparatorMatches() public {
        bytes32 expected = vm.parseJsonBytes32(fixtures, ".domainSeparator");
        uint256 chainId = vm.parseJsonUint(fixtures, ".chainId");
        address verifyingContract = vm.parseJsonAddress(fixtures, ".verifyingContract");
        bytes32 actual = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256(bytes("DeFacts")), keccak256(bytes("1")),
            chainId, verifyingContract
        ));
        assertEq(actual, expected, "DOMAIN_SEPARATOR disagreement");
    }

    function testTier1StructHashMatches() public {
        bytes32 expectedStruct = vm.parseJsonBytes32(fixtures, ".tier1.structHash");
        bytes32 psecVersion = vm.parseJsonBytes32(fixtures, ".tier1.message.psec_version");
        bytes32 modelCommitment = vm.parseJsonBytes32(fixtures, ".tier1.message.model_commitment");
        bytes32 inputHash = vm.parseJsonBytes32(fixtures, ".tier1.message.input_hash");
        bytes32 outputHash = vm.parseJsonBytes32(fixtures, ".tier1.message.output_hash");
        uint8 tier = uint8(vm.parseJsonUint(fixtures, ".tier1.message.tier"));
        bytes32 actual = keccak256(abi.encode(
            TIER1_TYPEHASH, psecVersion, modelCommitment, inputHash, outputHash, tier
        ));
        assertEq(actual, expectedStruct, "Tier1 structHash disagreement");
    }

    function testTier1DigestMatches() public {
        bytes32 expectedDigest = vm.parseJsonBytes32(fixtures, ".tier1.digest");
        bytes32 domainSeparator = vm.parseJsonBytes32(fixtures, ".domainSeparator");
        bytes32 structHash = vm.parseJsonBytes32(fixtures, ".tier1.structHash");
        bytes32 actual = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        assertEq(actual, expectedDigest, "Tier1 digest disagreement");
    }

    function testTier1SignatureRecovers() public {
        bytes32 digest = vm.parseJsonBytes32(fixtures, ".tier1.digest");
        bytes memory signature = vm.parseJsonBytes(fixtures, ".tier1.signature");
        address expected = vm.parseJsonAddress(fixtures, ".expectedSigner");
        address recovered = ECDSA.recover(digest, signature);
        assertEq(recovered, expected, "Tier1 ECDSA.recover failed");
    }

    function testTier2TypeHashMatches() public {
        bytes32 expected = vm.parseJsonBytes32(fixtures, ".tier2.typeHash");
        assertEq(TIER2_TYPEHASH, expected, "TIER2_TYPEHASH disagreement");
    }

    function testTier2BuyerPubkeyHashMatches() public {
        bytes memory buyerPubkey = vm.parseJsonBytes(fixtures, ".tier2.message.buyer_pubkey");
        bytes32 expected = vm.parseJsonBytes32(fixtures, ".tier2.message.buyer_pubkey_hash");
        assertEq(keccak256(buyerPubkey), expected, "buyer_pubkey hash disagreement");
    }

    function testTier2StructHashMatches() public {
        bytes32 expectedStruct = vm.parseJsonBytes32(fixtures, ".tier2.structHash");
        bytes32 psecVersion = vm.parseJsonBytes32(fixtures, ".tier2.message.psec_version");
        bytes32 modelCommitment = vm.parseJsonBytes32(fixtures, ".tier2.message.model_commitment");
        bytes32 inputHash = vm.parseJsonBytes32(fixtures, ".tier2.message.input_hash");
        bytes32 outputHash = vm.parseJsonBytes32(fixtures, ".tier2.message.output_hash");
        uint8 tier = uint8(vm.parseJsonUint(fixtures, ".tier2.message.tier"));
        bytes memory buyerPubkey = vm.parseJsonBytes(fixtures, ".tier2.message.buyer_pubkey");
        bytes32 actual = keccak256(abi.encode(
            TIER2_TYPEHASH, psecVersion, modelCommitment, inputHash, outputHash, tier,
            keccak256(buyerPubkey)
        ));
        assertEq(actual, expectedStruct, "Tier2 structHash disagreement (likely bytes-substitution)");
    }

    function testTier2DigestMatches() public {
        bytes32 expectedDigest = vm.parseJsonBytes32(fixtures, ".tier2.digest");
        bytes32 domainSeparator = vm.parseJsonBytes32(fixtures, ".domainSeparator");
        bytes32 structHash = vm.parseJsonBytes32(fixtures, ".tier2.structHash");
        bytes32 actual = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        assertEq(actual, expectedDigest, "Tier2 digest disagreement");
    }

    function testTier2SignatureRecovers() public {
        bytes32 digest = vm.parseJsonBytes32(fixtures, ".tier2.digest");
        bytes memory signature = vm.parseJsonBytes(fixtures, ".tier2.signature");
        address expected = vm.parseJsonAddress(fixtures, ".expectedSigner");
        address recovered = ECDSA.recover(digest, signature);
        assertEq(recovered, expected, "Tier2 ECDSA.recover failed");
    }

    function testTier1RecoveryFailsOnTamperedDigest() public {
        bytes32 digest = vm.parseJsonBytes32(fixtures, ".tier1.digest");
        bytes memory signature = vm.parseJsonBytes(fixtures, ".tier1.signature");
        address expected = vm.parseJsonAddress(fixtures, ".expectedSigner");
        bytes32 tampered = digest ^ bytes32(uint256(1));
        address recovered = ECDSA.recover(tampered, signature);
        assertTrue(recovered != expected, "Tampered digest still recovered");
    }
}
