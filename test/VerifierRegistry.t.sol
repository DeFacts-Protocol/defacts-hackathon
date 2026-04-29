// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";

contract VerifierRegistryTest is Test {
    VerifierRegistry registry;

    address constant OWNER       = address(0xA11CE);
    address constant STRANGER    = address(0xDEAD);
    address constant STUB_VERIFIER  = address(0x1111);
    address constant PD19_VERIFIER  = address(0x2222);
    address constant STUB_VERIFIER2 = address(0x3333);

    event VerifierRegistered(string indexed proof_format, address indexed verifier);

    function setUp() public {
        vm.prank(OWNER);
        registry = new VerifierRegistry();
    }

    function testOwnerIsDeployer() public {
        assertEq(registry.owner(), OWNER);
    }

    function testOwnerRegistersStubV1() public {
        vm.prank(OWNER);
        registry.register("stub-v1", STUB_VERIFIER);
        assertEq(registry.getVerifier("stub-v1"), STUB_VERIFIER);
    }

    function testOwnerRegistersMultipleFormats() public {
        vm.startPrank(OWNER);
        registry.register("stub-v1", STUB_VERIFIER);
        registry.register("pd19-v1", PD19_VERIFIER);
        vm.stopPrank();

        assertEq(registry.getVerifier("stub-v1"), STUB_VERIFIER);
        assertEq(registry.getVerifier("pd19-v1"), PD19_VERIFIER);
        // Different formats must map to different verifiers
        assertTrue(registry.getVerifier("stub-v1") != registry.getVerifier("pd19-v1"));
    }

    function testRegisterEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit VerifierRegistered("stub-v1", STUB_VERIFIER);

        vm.prank(OWNER);
        registry.register("stub-v1", STUB_VERIFIER);
    }

    function testNonOwnerRegisterReverts() public {
        vm.prank(STRANGER);
        vm.expectRevert(VerifierRegistry.NotOwner.selector);
        registry.register("stub-v1", STUB_VERIFIER);
    }

    function testReregistrationUpdatesVerifier() public {
        // Verifier rotation: register stub-v1 → A, then re-register stub-v1 → B
        vm.startPrank(OWNER);
        registry.register("stub-v1", STUB_VERIFIER);
        assertEq(registry.getVerifier("stub-v1"), STUB_VERIFIER);

        registry.register("stub-v1", STUB_VERIFIER2);
        assertEq(registry.getVerifier("stub-v1"), STUB_VERIFIER2);
        // Old address no longer registered for stub-v1
        assertTrue(registry.getVerifier("stub-v1") != STUB_VERIFIER);
        vm.stopPrank();
    }

    function testUnregisteredFormatReturnsZero() public {
        assertEq(registry.getVerifier("does-not-exist"), address(0));
    }

    function testRegisterZeroAddressDeregisters() public {
        vm.startPrank(OWNER);
        registry.register("stub-v1", STUB_VERIFIER);
        assertEq(registry.getVerifier("stub-v1"), STUB_VERIFIER);

        // Setting to address(0) is the de-registration path
        registry.register("stub-v1", address(0));
        assertEq(registry.getVerifier("stub-v1"), address(0));
        vm.stopPrank();
    }
}
