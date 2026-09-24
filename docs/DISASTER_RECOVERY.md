# Disaster Recovery and Rebuild Operations

This document defines the recovery objectives, procedures, and responsibilities for the TruthBounty V2 Backend in the event of a catastrophic failure, chain reorg, or data corruption.

## Security and Integrity Guidelines

> [!CAUTION]
> **Blockchain Authority Boundary:** Smart contracts remain strictly authoritative. Cached, operational, or CI state must NEVER decide protocol outcomes.

- **No Production Secrets:** Do not hardcode, test with, or log production secrets, dummy addresses, or Stellar/Freighter dependencies in this repository or these commands.
- **Fail-Closed Validation:** All restoration processes must fail-closed if artifact integrity checks fail.

## Recovery Objectives

- **Recovery Time Objective (RTO):** < 4 hours from incident declaration.
- **Recovery Point Objective (RPO):** Real-time (indexer deterministically rebuilds from chain data).
- **Incident Ownership:** The on-call DevOps lead coordinates with the Protocol Engineering team.

## Procedures

### 1. Artifact Validation
Before any restoration, validate the binaries and configurations.
```bash
# Verify checksums (placeholders only)
sha256sum -c config.checksums
```

### 2. Shadow Rebuild
To verify indexer integrity without mutating production:
```bash
# Run the indexer in shadow mode
npm run indexer:shadow -- --start-block <BLOCK_NUMBER>
```

### 3. Indexer Bootstrap
If the local cache/database is lost or corrupted, bootstrap from the authoritative chain.
```bash
# Wipe cache and resync from genesis or a safe checkpoint
npm run indexer:bootstrap -- --clean --checkpoint <SAFE_CHECKPOINT>
```

### 4. Chain Reorg Response and Canonical Reapplication
The system handles chain reorganizations (fork switches) using `ReorgRollbackService` (`src/v2/events/reorg-rollback.service.ts`):
- **Reorg Rollback:** Purges orphaned events with `blockNumber > rollbackToBlock` from `v2_canonical_events`, updates checkpoints (`lastSafeBlock`), rewinds projector cursors (`v2_projector_cursors`), and reverts/prunes downstream read models (`v2_project_evidence`, `v2_project_evidence_version`, `v2_project_verification_round`, `v2_project_participant_position`, `v2_project_dispute`, `v2_indexing_anomalies`).
- **Canonical Reapplication:** Deterministically ingests new canonical logs on the winning fork `(blockNumber ASC, logIndex ASC)` and triggers all registered V2 projectors (`EvidenceProjectorService`, `VerificationProjectorService`, `DisputesProjectorService`) to advance read models.
- **Reprojection from Genesis:** `rebuildAllProjections()` resets cursors and reconstructs all read models from genesis.

```bash
# Example programmatic invocation via ReorgRollbackService
await reorgRollbackService.handleReorg({
  chainId: 10,
  rollbackToBlock: 12345678n,
  newLogs: winningForkRawLogs,
});
```

### 5. Database Rollback
If a faulty migration corrupts the local view (remember, chain state is authoritative):
```bash
# Restore from the last known good snapshot
pg_restore -d <DB_NAME> backup.dump
```

## Backup and Restore Verification
Backups of user preferences or non-authoritative metrics must be verified weekly.
```bash
# Restore to a test instance
npm run db:restore:test -- --file <BACKUP_FILE>
```
