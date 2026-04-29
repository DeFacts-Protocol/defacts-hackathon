// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract HelloWorld {
    string public message;
    function setMessage(string calldata _m) external { message = _m; }
    function getMessage() external view returns (string memory) { return message; }
}
