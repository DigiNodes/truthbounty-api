# SC-004 Verification Submission Engine - Gas Benchmarks

## Overview
This document outlines the gas cost benchmarks for the TruthBounty VerificationEngine smart contract. Measurements were taken via Hardhat local network tests.

## Results

| Operation | Gas Used | Notes |
| :--- | :--- | :--- |
| **First Verification Submission** | `392,849` | High gas due to initial mapping allocations for `hasVerified`, `_verifications`, and `_claimVerificationIds` arrays, plus stake token transfer. |
| **Subsequent Verification Submission** | `341,561` | Lower gas as some storage mappings (`_claimVerificationIds` length update instead of initialization) are already warm. |
| **Duplicate Prevention Revert** | `< 30,000` | Fails fast via mapping lookup. |
| **Retrieval Operations** | `N/A (view)` | `getVerification`, `getClaimVerifications`, `getVerificationCount`, and `getVerifierStake` do not modify state and execute locally for free. |

## Optimizations Made
- Used custom errors (e.g. `error AlreadyVerified()`) instead of string reverts to save deployment and execution gas.
- Minimized storage variables and utilized efficient array pushes and mapping reads.
- Kept the engine completely deterministic without expensive cross-contract loops.
