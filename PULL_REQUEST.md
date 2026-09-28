# V2-BE: Implement Reorg Rollback and Canonical Reapplication

## 📚 Overview
Implements atomic, deterministic **Reorg Rollback and Canonical Reapplication** for the V2 backend read model and canonical event store. TruthBounty treats deployed Optimism/EVM contracts and canonical chain events as protocol authority. This change ensures that whenever an EVM chain reorganization occurs, the event-sourced read models and checkpoints can be rolled back to a safe block height and newly canonical events from the winning fork can be reapplied without state corruption, data drift, or unauthorized protocol mutation.

---

## 🎯 Acceptance Criteria & Key Capabilities

- [x] **Atomic Reorg Rollback (`ReorgRollbackService.rollback`)**:
  - Purges orphaned events with `blockNumber > rollbackToBlock` from `v2_canonical_events`.
  - Purges orphaned quarantine records from `v2_event_quarantines`.
  - Atomically adjusts ingestion checkpoints (`v2_event_checkpoints`) where `lastSafeBlock > rollbackToBlock`.
  - Rewinds projector cursors (`v2_projector_cursors`) down to `rollbackToBlock`.
  - Reverts and prunes affected read models across all V2 schemas (`ProjectEvidence`, `ProjectEvidenceVersion`, `ProjectVerificationRound`, `ProjectParticipantPosition`, `ProjectDispute`, `IndexingAnomaly`).
  - Executes completely inside an isolated database transaction.

- [x] **Deterministic Canonical Reapplication (`ReorgRollbackService.reapplyLogs`)**:
  - Deterministically sorts raw logs in protocol order `(blockNumber ASC, logIndex ASC)`.
  - Ingests logs into `v2_canonical_events` using `CanonicalEventsService`.
  - Coordinates and drains all registered V2 projectors (`EvidenceProjectorService`, `VerificationProjectorService`, `DisputesProjectorService`) to advance read models to the winning canonical tip.

- [x] **Full Genesis Rebuild (`ReorgRollbackService.rebuildAllProjections`)**:
  - Clears projector read models and resets cursors to replay and reconstruct all projections from genesis.

- [x] **Fail-Closed & Security Invariants**:
  - Fails closed on invalid chain IDs (must be positive integer) and negative/invalid block heights.
  - Strict Optimism/EVM runtime scope only (no alternate-chain runtimes).
  - Preserves TypeORM-only persistence boundary with no secondary ORM.
  - Smart contracts and finalized events remain protocol authority; no backend-authoritative mutation introduced.

- [x] **Testing & Verification**:
  - Comprehensive unit tests ([reorg-rollback.service.spec.ts](file:///src/v2/events/reorg-rollback.service.spec.ts)) for validation, deterministic log sorting, and batch draining.
  - Comprehensive integration tests ([reorg-rollback.service.integration.spec.ts](file:///src/v2/events/reorg-rollback.service.integration.spec.ts)) for deep reorg rollback, evidence version rollback/deletion, verification round/position rollback, dispute status reversion, anomaly pruning, winning-fork canonical reapplication, and genesis rebuild.

---

## 🧩 Technical Scope & Files Changed

- `src/v2/events/interfaces/reorg-rollback.interface.ts`: Data types and interfaces for `ReorgRollbackResult`, `CanonicalReapplicationResult`, `ReorgExecutionResult`, `ReorgOptions`, `AffectedReadModels`, and `IV2Projector`.
- `src/v2/events/reorg-rollback.service.ts`: Core service implementing atomic rollback, log reapplication, projector coordination, and disaster recovery rebuilds.
- `src/v2/events/v2-events.module.ts`: Module provider and export registration.
- `src/v2/events/index.ts`: Module export barrel.
- `src/v2/events/reorg-rollback.service.spec.ts`: Unit test suite.
- `src/v2/events/reorg-rollback.service.integration.spec.ts`: Integration test suite with in-memory database.
- `docs/DISASTER_RECOVERY.md`: Operator documentation updated for V2 chain reorg response and reapplication procedures.

---

## 🏷️ Labels
`backend` `complexity-low` `wave-candidate`
