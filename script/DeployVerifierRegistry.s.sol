// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {VerifierRegistry} from "../src/VerifierRegistry.sol";

/**
 * @title Deploy VerifierRegistry
 * @notice One-shot deploy + register-stub-v1 script.
 *
 * Usage:
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   export STUB_VERIFIER_ADDR=0x...      # verifier-stub's address from /address endpoint
 *   forge script script/DeployVerifierRegistry.s.sol --rpc-url $GALILEO_RPC --broadcast
 *
 * Captures:
 *   - Logs the deployed VerifierRegistry address (paste into .env as VERIFIER_REGISTRY_ADDR)
 *   - Auto-registers stub-v1 → STUB_VERIFIER_ADDR if env var is set
 *   - Skips registration if STUB_VERIFIER_ADDR is unset (empty deploy)
 */
contract DeployVerifierRegistry is Script {
    function run() external returns (VerifierRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Deployer balance (wei):", deployer.balance);

        vm.startBroadcast(deployerKey);
        registry = new VerifierRegistry();
        console.log("VerifierRegistry deployed at:", address(registry));

        // Auto-register stub-v1 if STUB_VERIFIER_ADDR is provided.
        // Use try/catch around envAddress so missing env doesn't break the deploy.
        try vm.envAddress("STUB_VERIFIER_ADDR") returns (address stubAddr) {
            if (stubAddr != address(0)) {
                registry.register("stub-v1", stubAddr);
                console.log("Registered stub-v1 ->", stubAddr);
            }
        } catch {
            console.log("STUB_VERIFIER_ADDR not set; skipping stub-v1 registration");
        }

        // Auto-register pd19-v1 if PD19_VERIFIER_ADDR is provided (Day 4 hook).
        try vm.envAddress("PD19_VERIFIER_ADDR") returns (address pd19Addr) {
            if (pd19Addr != address(0)) {
                registry.register("pd19-v1", pd19Addr);
                console.log("Registered pd19-v1 ->", pd19Addr);
            }
        } catch {
            // pd19-v1 doesn't exist yet on Day 2; silent skip.
        }

        vm.stopBroadcast();

        console.log("");
        console.log("Add this to your .env:");
        console.log(string.concat("VERIFIER_REGISTRY_ADDR=", _toHexString(address(registry))));
    }

    function _toHexString(address a) internal pure returns (string memory) {
        return vm.toString(a);
    }
}
