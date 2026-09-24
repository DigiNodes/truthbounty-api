// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IClaimRegistry {
    function claimExists(uint256 claimId) external view returns (bool);
    function isClaimUnderVerification(uint256 claimId) external view returns (bool);
    function isClaimResolved(uint256 claimId) external view returns (bool);
}
