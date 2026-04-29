// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @title Deploy Escrow
 * @notice Deploys Escrow.sol pointing at an already-deployed VerifierRegistry.
 *
 * Usage:
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   export VERIFIER_REGISTRY_ADDR=0x...   # from Step 6 deploy
 *   forge script script/DeployEscrow.s.sol --rpc-url $GALILEO_RPC --broadcast --legacy
 *
 * After deploy:
 *   1. Add ESCROW_ADDR=<deployed> to .env
 *   2. Restart verifier-stub with the new ESCROW_ADDR so future signatures
 *      use the correct EIP-712 domain. Old signatures (made against a
 *      different ESCROW_ADDR) will not recover correctly against this Escrow.
 */
contract DeployEscrow is Script {
    function run() external returns (Escrow escrow) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address registry = vm.envAddress("VERIFIER_REGISTRY_ADDR");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:                 ", deployer);
        console.log("Deployer balance (wei):   ", deployer.balance);
        console.log("VerifierRegistry:         ", registry);

        require(registry != address(0), "VERIFIER_REGISTRY_ADDR not set");

        vm.startBroadcast(deployerKey);
        escrow = new Escrow(registry);
        vm.stopBroadcast();

        console.log("Escrow deployed at:       ", address(escrow));
        console.log("DOMAIN_SEPARATOR:         ");
        console.logBytes32(escrow.DOMAIN_SEPARATOR());
        console.log("");
        console.log("Add this to your .env:");
        console.log(string.concat("ESCROW_ADDR=", vm.toString(address(escrow))));
        console.log("");
        console.log("CRITICAL: restart verifier-stub with new ESCROW_ADDR before");
        console.log("attempting any settlement, or signatures will not recover.");
    }
}
