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

### 4. Chain Reorg Response
The system typically handles minor reorgs automatically. For deep reorgs:
```bash
# Force the indexer to rollback and re-evaluate from a specific block
npm run indexer:rollback -- --block <SAFE_BLOCK>
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
