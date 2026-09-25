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


## 6. Evidence Integrity Recovery (V2-BE-013)

Evidence integrity hashes provide tamper detection for V2 evidence projections. Recovery procedures ensure canonical chain remains authoritative.

### Evidence Integrity Corruption Detection

**Indicators:**
- Integrity verification endpoints return `valid: false`
- `hash_mismatch` or `chain_break` errors
- Multiple evidence items failing verification after deployment

**Verification:**
```bash
# Check overall integrity health
curl http://localhost:3000/v2/evidence/integrity/health

# Verify specific evidence
curl http://localhost:3000/v2/claims/{CLAIM_ID}/evidence/integrity

# Sample verification across dataset
curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
  -H "Content-Type: application/json" \
  -d '{"evidenceIds": ["0x123...", "0x456..."]}' 
```

### Recovery Procedure: Single Evidence Corruption

```bash
# Step 1: Stop projector
systemctl stop truthbounty-projector

# Step 2: Backup corrupted evidence
pg_dump -t v2_project_evidence \
  -t v2_project_evidence_version \
  --data-only \
  -d truthbounty \
  | grep '{EVIDENCE_ID}' > evidence_backup_{EVIDENCE_ID}_$(date +%Y%m%d).sql

# Step 3: Identify first canonical event for this evidence
SELECT MIN(block_number) as first_block, MIN(log_index) as first_log
FROM v2_canonical_events 
WHERE claim_id = '{CLAIM_ID}' 
AND event_name IN ('EvidenceRegistered', 'EvidenceReplaced', 'EvidenceRemoved');

# Step 4: Delete corrupted evidence records
DELETE FROM v2_project_evidence_version WHERE evidence_id = '{EVIDENCE_ID}';
DELETE FROM v2_project_evidence WHERE evidence_id = '{EVIDENCE_ID}';

# Step 5: Reset projector cursor to re-project from canonical events
UPDATE v2_projector_cursors 
SET last_block_number = {FIRST_BLOCK - 1}, 
    last_log_index = -1 
WHERE projector_name = 'v2-evidence';

# Step 6: Restart projector (rebuilds from chain authority)
systemctl start truthbounty-projector

# Step 7: Monitor re-projection
journalctl -u truthbounty-projector -f | grep "applied"

# Step 8: Verify integrity after rebuild
curl http://localhost:3000/v2/claims/{CLAIM_ID}/evidence/integrity
```

### Recovery Procedure: Mass Evidence Corruption

**Scenario:** Multiple evidence items corrupted (>5% failure rate)

```bash
# Step 1: Declare incident and stop all writes
systemctl stop truthbounty-projector

# Step 2: Full database backup
pg_dump truthbounty > truthbounty_before_recovery_$(date +%Y%m%d_%H%M%S).sql

# Step 3: Assess corruption scope
SELECT 
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE integrity_hash IS NULL) as missing_hash,
  COUNT(*) FILTER (WHERE integrity_hash IS NOT NULL) as has_hash
FROM v2_project_evidence;

# Step 4: Decision point
# Option A: If >50% corrupted, restore from last known-good backup
#   then replay canonical events from that point
# Option B: If <50% corrupted, delete all evidence projections
#   and rebuild entirely from canonical events

# Option B (recommended - canonical events are source of truth):
TRUNCATE v2_project_evidence_version CASCADE;
TRUNCATE v2_project_evidence CASCADE;

# Step 5: Reset projector cursor to genesis
UPDATE v2_projector_cursors 
SET last_block_number = 0, 
    last_log_index = -1 
WHERE projector_name = 'v2-evidence';

# Step 6: Restart projector (full rebuild from chain)
systemctl start truthbounty-projector

# Step 7: Monitor rebuild progress
# This may take hours depending on event count
journalctl -u truthbounty-projector -f

# Step 8: Verify completion
curl http://localhost:3000/v2/evidence/integrity/statistics

# Step 9: Run integrity verification on sample
psql truthbounty -t -c "SELECT evidence_id FROM v2_project_evidence ORDER BY RANDOM() LIMIT 100" \
  | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  | curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
      -H "Content-Type: application/json" \
      -d @-

# Step 10: Resume normal operations
systemctl start truthbounty-api
```

### Integrity Hash Backfill (Migration Recovery)

**Scenario:** Migration deployed but backfill failed or incomplete

```bash
# Step 1: Check backfill status
curl http://localhost:3000/v2/evidence/integrity/statistics

# Step 2: If any unstamped records exist
# Example response:
# {
#   "evidenceUnstamped": 150,
#   "versionsUnstamped": 320,
#   ...
# }

# Step 3: Stop projector to prevent concurrent writes
systemctl stop truthbounty-projector

# Step 4: Run backfill utility
npm run evidence:backfill -- --batch-size 100

# Expected output:
# Starting version integrity hash backfill...
# Stamped 100 versions so far...
# ...
# Backfill complete: 3200 versions, 1500 evidence, 0 errors

# Step 5: Verify 100% completion
curl http://localhost:3000/v2/evidence/integrity/statistics
# Should show evidenceUnstamped: 0, versionsUnstamped: 0

# Step 6: Restart projector
systemctl start truthbounty-projector
```

### Chain Reorg Impact on Evidence Integrity

**Normal Behavior:**
- Canonical event store detects reorg
- Projector automatically rolls back affected evidence versions
- Re-projects new canonical chain
- Integrity hashes recomputed automatically

**Verification After Reorg:**
```bash
# Check projector cursor position
SELECT * FROM v2_projector_cursors WHERE projector_name = 'v2-evidence';

# Verify affected evidence (if known)
curl http://localhost:3000/v2/claims/{AFFECTED_CLAIM_ID}/evidence/integrity

# Check chain-of-custody
curl http://localhost:3000/v2/claims/{AFFECTED_CLAIM_ID}/evidence/integrity \
  | jq '.chainOfCustody'
```

**No operator action required unless:**
- Integrity verification fails after reorg (indicates projector bug)
- Chain-of-custody broken (indicates incorrect rollback)

If either occurs, follow **Single Evidence Corruption** recovery procedure.

### Preventive Measures

1. **Weekly Integrity Audits:**
   ```bash
   # Run every Monday at 02:00
   0 2 * * 1 /usr/local/bin/evidence-integrity-audit.sh
   ```

2. **Pre-Deployment Verification:**
   ```bash
   # Before any migration or major release
   curl http://localhost:3000/v2/evidence/integrity/statistics > pre_deploy_integrity.json
   curl http://localhost:3000/v2/evidence/integrity/health >> pre_deploy_integrity.json
   ```

3. **Post-Deployment Verification:**
   ```bash
   # After deployment, verify integrity maintained
   curl http://localhost:3000/v2/evidence/integrity/health
   # Compare statistics to pre-deployment baseline
   ```

4. **Monitoring Alerts:**
   - Alert on any integrity verification failures
   - Alert if unstamped record count increases
   - Alert if projector halts due to hash computation error

### Emergency Contacts

- **Evidence Integrity Issues:** On-call Protocol Engineer
- **Runbook:** `docs/EVIDENCE_INTEGRITY_RUNBOOK.md`
- **Design Document:** `docs/V2_EVIDENCE_INTEGRITY_DESIGN.md`
