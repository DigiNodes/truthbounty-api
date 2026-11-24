# PREWAVE-BE-062: Versioned Sybil-Risk Scores with Explainable Provenance

## Overview

This specification establishes the production-readiness boundary for Sybil resistance and Sybil risk scoring in TruthBounty. It defines score versioning, feature provenance, freshness evaluation, bounds enforcement, missing-feature behavior, appeal/recomputation lifecycles, and privacy guarantees.

## 1. Score Versions & Model Registry

Scoring algorithms and weight configurations are explicitly versioned and tracked via `SybilModelRegistry`.

| Model Version | Algorithm | Weights (WC / Tenure / Stake / Accuracy) | Max Freshness | Baseline Prior Risk |
|---|---|---|---|---|
| `1.0.0` | `weighted-composite-sigmoidal` | 0.30 / 0.25 / 0.25 / 0.20 | 30 days | 0.85 |
| `2.0.0` | `multi-factor-penalized-risk` | 0.35 / 0.20 / 0.25 / 0.20 | 14 days | 0.90 |

### Invariants:
- **Pinned Version Reproducibility:** Computing or recomputing a score with a pinned version and identical inputs produces bit-for-bit reproducible results and identical cryptographic provenance digests.
- **Model Version Independence:** Upgrading default models does not mutate previously computed scores or pinned recomputations.

## 2. Feature Provenance & Canonical Chain Binding

Each signal carries structured provenance metadata:

- **On-chain Staking Deposits:** Bound to canonical chain provenance (`chainId`, `releaseId`, `artifactHash`, `contractAddress`, and `finalizedThroughBlock`).
- **Identity (WorldID):** Tracks `verifiedAt`, `verificationLevel`, `nullifierHash`, and `proof` internally while redacting sensitive fields in public endpoints.
- **Wallet Tenure:** Tracks account tenure, linked wallet count, and history.
- **Accuracy:** Tracks claims evaluated and correct verdicts from canonical protocol history.

### Canonical Consensus Invariant:
Canonical finalized contract events remain authoritative. Scoring services fail closed (`UnauthorizedProvenanceException`) if:
- Chain ID, release ID, or contract address does not match canonical deployment manifest.
- Staking deposit block numbers exceed the finalized checkpoint.
- Events are not finalized or not canonical.

## 3. Freshness & Fail-Closed Evaluation

Each feature has an observation timestamp. Freshness is calculated as `elapsedMs = now - observedAt`.

- If `elapsedMs > maxFreshnessMs`, the feature is marked `isStale: true`.
- In strict/production mode (`failClosedOnStale: true`), stale features trigger `StaleFeatureException`.
- Future-dated timestamps (`elapsedMs < -5000`) are rejected with `InvalidFeatureBoundsException`.

## 4. Bounds & Extreme Input Handling

Inputs and outputs are strictly bounded:
- `oldestWalletAgeMs`: non-negative finite number, saturated smoothly via fixed-point sigmoid math.
- `totalStakedAmount`: non-negative bigint, normalized using logarithmic scaling (`log1p`) to eliminate numerical overflow or whale dominance.
- `claimsVotedOn` & `claimsCorrect`: non-negative integers; `claimsCorrect <= claimsVotedOn` is strictly enforced.
- Scores (`score` and `riskScore`) are strictly clamped to `[0.0000, 1.0000]`.

## 5. Missing-Feature Behavior (Non-Zero Risk Guarantee)

**Acceptance Criterion:** *Missing inputs do not silently become zero-risk.*

- When an entity lacks signals (e.g., brand-new account with no WorldID, no wallet history, no staking, no voting), missing features are explicitly enumerated in `missingFeatures`.
- A missing feature contributes zero resistance and enforces an uncertainty risk floor.
- An empty entity with no signals receives maximum prior risk (`riskScore = 1.0`, `riskLevel = CRITICAL`), never `0.0`.
- In strict mode (`failClosedOnMissing: true`), missing features trigger `MissingFeatureException`.

## 6. Privacy & Sensitive Feature Redaction

**Acceptance Criterion:** *Sensitive features are not exposed publicly.*

- Public endpoint `GET /sybil/users/:userId/public-score` returns `PublicSybilScoreView`.
- Strictly scrubbed and omitted from public views:
  - WorldID `nullifierHash`
  - Zero-knowledge `proof` payloads
  - Raw multi-wallet address mappings
- Public responses expose only non-PII signal summaries, public explanations, and the cryptographic provenance digest.

## 7. Appeal & Deterministic Recompute Lifecycle

- `POST /sybil/users/:userId/recompute`: Deterministically recalculates score against pinned or target model versions.
- `POST /sybil/users/:userId/appeal`: Allows users to submit appeals with structured reasons and fresh evidence.
- An auditable `SybilAppealRecord` is recorded with prior score, new score, status (`RESOLVED` or `UPHELD`), reason, and timestamp.
- `GET /sybil/users/:userId/appeals`: Retrieves appeal history.

## 8. Contract Outcome Immutability

**Acceptance Criterion:** *Score cannot directly mutate contract outcome.*

- The Sybil score and risk models operate strictly as off-chain advisory read models.
- Neither scoring, recomputing, nor appeal operations broadcast transactions or mutate smart contract state.
