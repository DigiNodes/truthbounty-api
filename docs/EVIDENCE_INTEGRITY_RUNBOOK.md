# Evidence Integrity Operations Runbook

**Document Version:** 1.0  
**Last Updated:** 2026-09-24  
**Applies To:** TruthBounty V2 Backend (V2-BE-013)  
**Operator Level:** L2+ (requires database access)

## Overview

This runbook provides step-by-step procedures for operators managing the Evidence Metadata Integrity Protection system introduced in V2-BE-013. Evidence integrity hashes enable detection of database corruption, unauthorized mutation, and reorg-induced inconsistencies.

## Architecture Summary

- **Evidence Projector:** Stamps cryptographic SHA-256 hashes on evidence metadata during canonical event replay
- **Hash Fields:** `integrityHash` (current state), `previousVersionHash` (chain-of-custody)
- **Verification:** Read-only endpoints for on-demand and scheduled integrity checks
- **Fail-Closed:** Hash computation failures rollback transactions and halt projector

## Health Check Endpoints

### Evidence Integrity Health Status

```bash
GET /v2/evidence/integrity/health
```

**Response:**
```json
{
  "status": "healthy" | "degraded" | "critical",
  "timestamp": "2026-09-24T10:00:00Z",
  "totalEvidence": 1500,
  "evidenceStamped": 1498,
  "versionsStamped": 3200,
  "evidenceStampedPercentage": "99.87",
  "versionsStampedPercentage": "100.00",
  "overallStampedPercentage": "99.87"
}
```

**Status Thresholds:**
- `healthy`: ≥99% of records stamped
- `degraded`: 95-99% of records stamped
- `critical`: <95% of records stamped

**Action:**
- `healthy`: No action required
- `degraded`: Schedule backfill during maintenance window
- `critical`: **Immediate action required** - Run backfill immediately

### Integrity Statistics

```bash
GET /v2/evidence/integrity/statistics
```

**Response:**
```json
{
  "totalEvidence": 1500,
  "totalVersions": 3200,
  "evidenceStamped": 1498,
  "versionsStamped": 3200,
  "evidenceUnstamped": 2,
  "versionsUnstamped": 0
}
```

## Common Scenarios

### Scenario 1: Single Evidence Integrity Failure

**Symptom:** Alert triggered for integrity hash mismatch on specific evidence

**Diagnostic Steps:**

1. **Verify the integrity failure:**
   ```bash
   curl http://localhost:3000/v2/claims/{CLAIM_ID}/evidence/integrity
   ```

2. **Check for recent database changes:**
   ```bash
   # Review recent audit logs
   SELECT * FROM audit_logs 
   WHERE entity_type = 'EVIDENCE' 
   AND entity_id = '{EVIDENCE_ID}'
   ORDER BY created_at DESC 
   LIMIT 10;
   ```

3. **Identify the specific failure:**
   - `hash_mismatch`: Field value changed without hash update (corruption or unauthorized write)
   - `hash_missing`: Record created without integrity hash (migration incomplete)
   - `chain_break`: Version history chain broken (previousVersionHash mismatch)

**Resolution Steps:**

#### For `hash_mismatch` (Database Corruption):

```bash
# Step 1: Stop the projector to prevent further processing
systemctl stop truthbounty-projector

# Step 2: Identify affected canonical events
SELECT * FROM v2_canonical_events 
WHERE claim_id = '{CLAIM_ID}' 
ORDER BY block_number, log_index;

# Step 3: Backup corrupted record
pg_dump -t v2_project_evidence \
  -t v2_project_evidence_version \
  --data-only \
  -d truthbounty \
  | grep '{EVIDENCE_ID}' > evidence_backup_{EVIDENCE_ID}.sql

# Step 4: Delete corrupted evidence records
DELETE FROM v2_project_evidence_version WHERE evidence_id = '{EVIDENCE_ID}';
DELETE FROM v2_project_evidence WHERE evidence_id = '{EVIDENCE_ID}';

# Step 5: Reset projector cursor to re-project from first relevant event
UPDATE v2_projector_cursors 
SET last_block_number = {FIRST_EVENT_BLOCK - 1}, 
    last_log_index = -1 
WHERE projector_name = 'v2-evidence';

# Step 6: Restart projector (will re-project from canonical events)
systemctl start truthbounty-projector

# Step 7: Verify integrity after re-projection
curl http://localhost:3000/v2/claims/{CLAIM_ID}/evidence/integrity
```

#### For `hash_missing` (Incomplete Migration):

```bash
# Run backfill for specific evidence
npm run evidence:backfill -- --evidence-id {EVIDENCE_ID}

# Or use API endpoint (if available)
curl -X POST http://localhost:3000/v2/evidence/integrity/backfill \
  -H "Content-Type: application/json" \
  -d '{"evidenceIds": ["{EVIDENCE_ID}"]}'
```

#### For `chain_break` (Broken Chain-of-Custody):

```bash
# This indicates version history corruption
# MUST rebuild from canonical events

# Step 1: Stop projector
systemctl stop truthbounty-projector

# Step 2: Delete all versions for this evidence
DELETE FROM v2_project_evidence_version WHERE evidence_id = '{EVIDENCE_ID}';

# Step 3: Reset evidence current state
DELETE FROM v2_project_evidence WHERE evidence_id = '{EVIDENCE_ID}';

# Step 4: Reset cursor to re-project
UPDATE v2_projector_cursors 
SET last_block_number = {FIRST_EVENT_BLOCK - 1}, 
    last_log_index = -1 
WHERE projector_name = 'v2-evidence';

# Step 5: Restart projector
systemctl start truthbounty-projector
```

### Scenario 2: Mass Integrity Failures (Migration Issue)

**Symptom:** Multiple evidence items showing integrity failures after deployment

**Diagnostic Steps:**

1. **Check overall health:**
   ```bash
   curl http://localhost:3000/v2/evidence/integrity/health
   ```

2. **Identify scale of issue:**
   ```bash
   SELECT 
     COUNT(*) FILTER (WHERE integrity_hash IS NULL) as unstamped_evidence,
     COUNT(*) FILTER (WHERE integrity_hash IS NOT NULL) as stamped_evidence
   FROM v2_project_evidence;

   SELECT 
     COUNT(*) FILTER (WHERE integrity_hash IS NULL) as unstamped_versions,
     COUNT(*) FILTER (WHERE integrity_hash IS NOT NULL) as stamped_versions
   FROM v2_project_evidence_version;
   ```

**Resolution Steps:**

```bash
# Step 1: Stop projector during backfill
systemctl stop truthbounty-projector

# Step 2: Run full backfill
npm run evidence:backfill

# Step 3: Monitor backfill progress
# Check logs for completion
journalctl -u truthbounty-api -f | grep "Backfill complete"

# Step 4: Verify statistics after backfill
curl http://localhost:3000/v2/evidence/integrity/statistics

# Step 5: Restart projector
systemctl start truthbounty-projector

# Step 6: Run verification on sample
curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
  -H "Content-Type: application/json" \
  -d '{"evidenceIds": ["0x123...", "0x456...", "0x789..."]}'
```

### Scenario 3: Projector Halted Due to Hash Computation Failure

**Symptom:** Projector in ERROR state, logs show hash computation failure

**Diagnostic Steps:**

1. **Check projector logs:**
   ```bash
   journalctl -u truthbounty-projector --since "10 minutes ago" | grep "Integrity hash computation failed"
   ```

2. **Identify problematic event:**
   ```bash
   # Look for evidenceId, version, eventTxHash in error logs
   # Example log:
   # Integrity hash computation failed for 0x123:v3
   # eventTxHash: 0xabc..., error: TypeError: Cannot read property 'toString'
   ```

3. **Inspect problematic canonical event:**
   ```sql
   SELECT * FROM v2_canonical_events 
   WHERE tx_hash = '{EVENT_TX_HASH}' 
   AND log_index = {LOG_INDEX};
   ```

**Resolution Steps:**

```bash
# Step 1: Verify event payload structure
# Check for malformed data (null where not expected, wrong types, etc.)

# Step 2: If event data is invalid (should not happen - indicates indexer bug)
# Create incident report and escalate to protocol team

# Step 3: If event data is valid (bug in hash computation logic)
# Hot-patch the EvidenceIntegrityService.computeVersionHash or computeEvidenceHash
# Deploy fix

# Step 4: Reset cursor to retry event
UPDATE v2_projector_cursors 
SET last_block_number = {PROBLEMATIC_EVENT_BLOCK - 1}, 
    last_log_index = -1 
WHERE projector_name = 'v2-evidence';

# Step 5: Restart projector
systemctl restart truthbounty-projector

# Step 6: Monitor logs for successful processing
journalctl -u truthbounty-projector -f
```

### Scenario 4: Chain Reorg Detected

**Symptom:** Evidence integrity changes after reorg, projector re-processing events

**Expected Behavior:**
- Projector detects reorg via canonical event store
- Rolls back affected evidence versions (blockNumber > last finalized)
- Re-projects new canonical chain events
- Integrity hashes automatically recomputed for new chain

**Verification Steps:**

```bash
# Step 1: Check projector cursor
SELECT * FROM v2_projector_cursors WHERE projector_name = 'v2-evidence';

# Step 2: Verify affected evidence re-projected correctly
curl http://localhost:3000/v2/claims/{AFFECTED_CLAIM_ID}/evidence/integrity

# Step 3: Verify chain-of-custody remains intact
# Check that previousVersionHash chain is valid
curl http://localhost:3000/v2/claims/{AFFECTED_CLAIM_ID}/evidence/integrity \
  | jq '.chainOfCustody'
```

**Action:** No operator intervention required unless integrity verification fails after reorg

### Scenario 5: Scheduled Maintenance - Full Integrity Verification

**When:** Weekly (recommended), or before/after major migrations

**Procedure:**

```bash
# Step 1: Get baseline statistics
curl http://localhost:3000/v2/evidence/integrity/statistics > integrity_stats_$(date +%Y%m%d).json

# Step 2: Sample verification (random 100 evidence items)
# Extract random evidenceIds from database
psql truthbounty -t -c "SELECT evidence_id FROM v2_project_evidence ORDER BY RANDOM() LIMIT 100" \
  | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  | curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
      -H "Content-Type: application/json" \
      -d @- \
  > integrity_sample_$(date +%Y%m%d).json

# Step 3: Review results
cat integrity_sample_$(date +%Y%m%d).json | jq '.summary'

# Step 4: If any failures, investigate specific items
cat integrity_sample_$(date +%Y%m%d).json | jq '.results[] | select(.valid == false)'

# Step 5: Document findings
echo "Weekly Integrity Check - $(date)" >> /var/log/truthbounty/integrity_audit.log
cat integrity_sample_$(date +%Y%m%d).json | jq '.summary' >> /var/log/truthbounty/integrity_audit.log
```

## Migration Procedures

### Initial Migration Deployment (Phase 1)

```bash
# Step 1: Apply schema migration (adds nullable columns)
npm run migration:run

# Step 2: Verify migration applied
psql truthbounty -c "\d v2_project_evidence_version"
# Should show integrity_hash and previous_version_hash columns

# Step 3: Deploy new application code
# (includes integrity stamping in projector)

# Step 4: Restart services
systemctl restart truthbounty-api
systemctl restart truthbounty-projector

# Step 5: Monitor logs for successful stamping on new events
journalctl -u truthbounty-projector -f | grep "applied"
```

### Backfill Existing Records (Phase 2)

**Timing:** Run during low-traffic maintenance window

```bash
# Step 1: Stop projector to avoid conflicts
systemctl stop truthbounty-projector

# Step 2: Run backfill script
npm run evidence:backfill -- --batch-size 100

# Expected output:
# Starting version integrity hash backfill...
# Stamped 100 versions so far...
# Stamped 200 versions so far...
# ...
# Starting evidence integrity hash backfill...
# Stamped 50 evidence records so far...
# ...
# Backfill complete: 3200 versions, 1500 evidence, 0 errors

# Step 3: Verify completion
curl http://localhost:3000/v2/evidence/integrity/statistics

# Should show 100% stamped
# evidenceStampedPercentage: "100.00"
# versionsStampedPercentage: "100.00"

# Step 4: Restart projector
systemctl start truthbounty-projector

# Step 5: Verify new events continue to get stamped
# Wait for next event projection and check logs
```

### Enforcement Migration (Phase 3)

**Prerequisites:** Phase 2 backfill must be 100% complete

```bash
# Step 1: Final verification before enforcement
curl http://localhost:3000/v2/evidence/integrity/statistics

# MUST show:
# evidenceUnstamped: 0
# versionsUnstamped: 0

# Step 2: Apply enforcement migration (makes columns NOT NULL)
npm run migration:run

# Step 3: Test that NULL inserts now fail
psql truthbounty -c "
  INSERT INTO v2_project_evidence_version 
  (id, evidence_id, version, content_digest, event_tx_hash, event_log_index, block_number, integrity_hash)
  VALUES (gen_random_uuid(), '0xtest', 1, '0xtest', '0xtest', 0, '1', NULL);
"
# Should fail with: ERROR: null value in column "integrity_hash" violates not-null constraint

# Step 4: Restart services
systemctl restart truthbounty-api
systemctl restart truthbounty-projector
```

## Monitoring and Alerts

### Prometheus Metrics

```yaml
# Integrity hash stamping rate
evidence_integrity_hash_stamped_total

# Integrity verification failures
evidence_integrity_verification_failures_total

# Hash computation duration
evidence_integrity_hash_computation_duration_seconds

# Unstamped record count
evidence_integrity_unstamped_records
```

### Alert Rules

```yaml
groups:
  - name: evidence_integrity
    rules:
      - alert: EvidenceIntegrityFailure
        expr: evidence_integrity_verification_failures_total > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} evidence records have integrity failures"
          runbook: "docs/EVIDENCE_INTEGRITY_RUNBOOK.md#scenario-1"

      - alert: EvidenceIntegrityUnstampedRecords
        expr: evidence_integrity_unstamped_records > 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} evidence records missing integrity hashes"
          runbook: "docs/EVIDENCE_INTEGRITY_RUNBOOK.md#scenario-2"

      - alert: EvidenceIntegrityHashComputationSlow
        expr: histogram_quantile(0.95, evidence_integrity_hash_computation_duration_seconds) > 1.0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "95th percentile hash computation exceeds 1 second"

      - alert: ProjectorHaltedIntegrityError
        expr: up{job="truthbounty-projector"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Projector halted, check for integrity hash computation failures"
          runbook: "docs/EVIDENCE_INTEGRITY_RUNBOOK.md#scenario-3"
```

## Troubleshooting

### Hash Computation is Slow

**Symptom:** High p95 latency on hash computation

**Diagnostic:**
```bash
# Check database CPU usage
SELECT * FROM pg_stat_activity WHERE state = 'active';

# Check if indexes exist
SELECT * FROM pg_indexes WHERE tablename LIKE 'v2_project_evidence%';
```

**Resolution:**
- Ensure indexes on `(evidence_id, version, integrity_hash)` exist
- Consider increasing batch size if backfilling (reduces I/O overhead)
- Check for table bloat and run `VACUUM ANALYZE`

### Projector Cursor Not Advancing

**Symptom:** Same events processed repeatedly

**Diagnostic:**
```bash
SELECT * FROM v2_projector_cursors WHERE projector_name = 'v2-evidence';

# Check last processed event
SELECT * FROM v2_canonical_events 
WHERE block_number = '{CURSOR_BLOCK}' 
AND log_index = '{CURSOR_LOG_INDEX}';
```

**Resolution:**
- Check projector logs for transaction rollback errors
- Verify integrity hash computation is not throwing exceptions
- Manually advance cursor if stuck on known-bad event (after fixing root cause)

### Duplicate Evidence Versions

**Symptom:** Multiple versions with same version number

**Diagnostic:**
```sql
SELECT evidence_id, version, COUNT(*) 
FROM v2_project_evidence_version 
GROUP BY evidence_id, version 
HAVING COUNT(*) > 1;
```

**Resolution:**
```bash
# This should NOT happen due to unique constraints
# If it does, indicates serious database corruption

# Step 1: Stop all services
systemctl stop truthbounty-api truthbounty-projector

# Step 2: Backup database
pg_dump truthbounty > backup_before_dedup_$(date +%Y%m%d).sql

# Step 3: Keep only latest version (by createdAt)
DELETE FROM v2_project_evidence_version v1
USING v2_project_evidence_version v2
WHERE v1.evidence_id = v2.evidence_id
  AND v1.version = v2.version
  AND v1.created_at < v2.created_at;

# Step 4: Verify uniqueness restored
# Should return 0 rows
SELECT evidence_id, version, COUNT(*) 
FROM v2_project_evidence_version 
GROUP BY evidence_id, version 
HAVING COUNT(*) > 1;

# Step 5: Restart services
systemctl start truthbounty-api truthbounty-projector
```

## References

- **Design Document:** `docs/V2_EVIDENCE_INTEGRITY_DESIGN.md`
- **Disaster Recovery:** `docs/DISASTER_RECOVERY.md`
- **Monitoring Guide:** `docs/MONITORING_GUIDE.md`
- **V2-BE-013 Issue:** Evidence Metadata Integrity Protection

## Escalation

- **L2 Operator:** Handle routine integrity checks, backfills, single-evidence failures
- **L3 Operator:** Handle mass failures, projector halts, reorg issues
- **Protocol Engineering:** Hash computation bugs, canonical event corruption, architectural issues

For critical failures affecting production data integrity, escalate immediately to on-call protocol engineer.
