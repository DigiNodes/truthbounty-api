# SC-004 Verification Submission Engine - Gas Benchmarks

## Overview
This document outlines the gas cost benchmarks for the TruthBounty VerificationEngine smart contract. Measurements were taken via Hardhat local network tests.

## Results

| Operation | Gas Used | Notes |
| :--- | :--- | :--- |
| **First Verification Submission** | `259,608` | Gas for allocating `_verifierToVerificationId`, `_claimVerificationIds` arrays, and `_verificationById`, plus stake token transfer. |
| **Subsequent Verification Submission** | `208,320` | Lower gas as `_claimVerificationIds` array length update is already warm. |
| **Duplicate Prevention Revert** | `< 30,000` | Fails fast via mapping lookup on `_verifierToVerificationId`. |
| **Retrieval Operations** | `N/A (view)` | `getVerification`, `getClaimVerifications`, `getVerificationCount`, `hasVerified` and `getVerifierStake` do not modify state and execute locally for free. |

## Optimizations Made
- Used custom errors (e.g. `error AlreadyVerified()`) instead of string reverts to save deployment and execution gas.
- Minimized storage variables by using a `_verifierToVerificationId` mapping instead of duplicating the entire `Verification` struct.
- Reordered the `Verification` struct to pack fields (`verifier`, `submittedAt`, `verdict`) reducing the storage footprint per verification.
- Kept the engine completely deterministic without expensive cross-contract loops.
