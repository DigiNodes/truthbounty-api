// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IClaimRegistry.sol";

contract MockRegistry is IClaimRegistry {
    mapping(uint256 => bool) public exists;
    mapping(uint256 => bool) public resolved;
    mapping(uint256 => bool) public underVerification;

    function setClaimStatus(uint256 claimId, bool _exists, bool _resolved, bool _underVerification) external {
        exists[claimId] = _exists;
        resolved[claimId] = _resolved;
        underVerification[claimId] = _underVerification;
    }

    function claimExists(uint256 claimId) external view returns (bool) {
        return exists[claimId];
    }
    
    function isClaimUnderVerification(uint256 claimId) external view returns (bool) {
        return underVerification[claimId];
    }
    
    function isClaimResolved(uint256 claimId) external view returns (bool) {
        return resolved[claimId];
    }
}
