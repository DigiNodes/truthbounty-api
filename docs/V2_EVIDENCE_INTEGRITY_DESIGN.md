# V2 Evidence Metadata Integrity Protection Design

**Issue:** V2-BE-013 - Protect Evidence Metadata Integrity  
**Status:** Implementation Ready  
**Last Updated:** 2026-09-24  
**Owner:** Backend Team

## Executive Summary

This design adds cryptographic integrity verification to V2 evidence projections (`ProjectEvidence` and `ProjectEvidenceVersion` entities) while preserving the chain-authoritative, append-only architecture. Evidence metadata integrity hashes enable detection of database corruption, unauthorized mutation, replay attacks, and reorg-induced inconsistencies without adding protocol-level state mutation.

## Design Principles

1. **Chain Authority Preserved:** Smart contracts and canonical events remain the single source of truth. Integrity hashes are detection-only; they never override protocol state.
2. **Fail-Closed Behavior:** Integrity verification failures halt projector advancement and trigger operator alerts. No silent fallback to potentially corrupted state.
3. **Deterministic Replay:** Hash computation is deterministic and reproducible from canonical events, enabling rebuild verification.
4. **Append-Only Integrity:** Version history integrity is cryptographically chained; tampering with any version invalidates all subsequent versions.
5. **Observable Failures:** All integrity failures are logged with actionable context (affected entities, hash mismatches, recovery procedures).

## Architecture

### Data Model Extensions

#### ProjectEvidenceVersion Entity
```typescript
@Entity('v2_project_evidence_version')
export class ProjectEvidenceVersion {
  // ... existing fields ...
  
  /**
   * SHA-256 integrity hash of version-specific canonical fields.
   * Computed from: evidenceId, version, contentDigest, safeMetadataUri,
   * submittedBy, eventTxHash, eventLogIndex, blockNumber, previousVersionHash.
   * Excludes: id (UUID), createdAt (backend timestamp), integrityHash itself.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  integrityHash: string | null;

  /**
   * Hash of the previous version, enabling cryptographic chain-of-custody.
   * NULL for version 1. For version N > 1, contains integrityHash of version N-1.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  previousVersionHash: string | null;
}
```

#### ProjectEvidence Entity
```typescript
@Entity('v2_project_evidence')
export class ProjectEvidence {
  // ... existing fields ...
  
  /**
   * SHA-256 integrity hash of current-state projection fields.
   * Computed from: evidenceId, claimId, currentVersion, status, contentDigest,
   * lastEventBlockNumber, lastEventLogIndex.
   * Excludes: createdAt, updatedAt (backend timestamps), integrityHash itself.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  integrityHash: string | null;
}
```

### Hash Computation Algorithm

#### Normalized Field Serialization
```typescript
interface VersionHashableFields {
  evidenceId: string;
  version: number;
  contentDigest: string;
  safeMetadataUri: string | null;
  submittedBy: string | null;
  eventTxHash: string;
  eventLogIndex: number;
  blockNumber: string; // bigint as string
  previousVersionHash: string | null;
}

interface EvidenceHashableFields {
  evidenceId: string;
  claimId: string;
  currentVersion: number;
  status: EvidenceStatus;
  contentDigest: string;
  lastEventBlockNumber: string;
  lastEventLogIndex: number;
}
```

#### Deterministic Hash Generation
1. **Normalize fields:** Convert all values to JSON-serializable primitives (bigints → strings, nulls preserved)
2. **Sort keys:** Alphabetically sort field names to prevent ordering-dependent hashes
3. **Serialize:** `JSON.stringify(normalized, sortedKeys)`
4. **Hash:** `sha256(serialized).hex()`

**Key Properties:**
- **Deterministic:** Same inputs always produce same hash
- **Collision-resistant:** SHA-256 provides 256-bit security
- **Tamper-evident:** Any field modification changes the hash
- **Chain-linked:** `previousVersionHash` creates Merkle-tree-like verification

### Integration Points

#### EvidenceProjectorService Modification
```typescript
// In applyEvent() after saving ProjectEvidenceVersion:
const versionHash = this.integrityService.computeVersionHash(versionRecord);
versionRecord.integrityHash = versionHash;
versionRecord.previousVersionHash = await this.getPreviousVersionHash(evidenceId, version - 1);
await versionRepo.save(versionRecord);

// After saving ProjectEvidence:
const evidenceHash = this.integrityService.computeEvidenceHash(evidenceRecord);
evidenceRecord.integrityHash = evidenceHash;
await evidenceRepo.save(evidenceRecord);
```

#### Transaction Boundaries
- Hash computation occurs **within the same database transaction** as entity persistence
- If hash computation fails, entire transaction rolls back
- Projector cursor advances **only after** successful hash stamping

### Failure Modes and Recovery

#### 1. Hash Computation Failure
**Cause:** Unexpected data type, missing required field, crypto library error  
**Detection:** Exception during `computeVersionHash()` or `computeEvidenceHash()`  
**Behavior:** 
- Transaction rolls back (version/evidence record NOT persisted)
- Projector cursor NOT advanced (event will be retried)
- Error logged with full context: `{ evidenceId, version, eventTxHash, error }`
- Projector enters `ERROR` state, stops processing

**Recovery:**
```bash
# Manual intervention required
npm run evidence:verify-integrity -- --repair-from-events
```

#### 2. Hash Verification Failure (Existing Records)
**Cause:** Database corruption, unauthorized mutation, migration bug  
**Detection:** `verifyIntegrity(evidenceId, version)` returns `{ valid: false }`  
**Behavior:**
- READ operations: Return data with integrity warning flag
- WRITE operations: Projector refuses to process events for corrupted evidence
- Health check reports degraded state

**Recovery:**
```bash
# Rebuild affected evidence from canonical events
npm run evidence:rebuild -- --evidence-id <ID> --from-block <SAFE_BLOCK>
```

#### 3. Chain-of-Custody Break
**Cause:** Missing version, previousVersionHash mismatch  
**Detection:** Version N's `previousVersionHash` ≠ Version N-1's `integrityHash`  
**Behavior:**
- Version N flagged as invalid
- All subsequent versions (N+1, N+2, ...) also flagged
- Projector halts on this evidence chain

**Recovery:**
```bash
# Full evidence rebuild from chain
npm run evidence:rebuild -- --evidence-id <ID> --verify-chain
```

#### 4. Reorg-Induced Inconsistency
**Cause:** Canonical event rollback without projector state rollback  
**Detection:** 
- Event cursor shows earlier block than latest evidence version
- Version exists with `blockNumber` > projector cursor
**Behavior:**
- Projector detects out-of-order state
- Marks affected versions for re-verification
- Re-projects from last known-good checkpoint

**Recovery:** Automatic (projector idempotency ensures correct final state)

#### 5. Migration Failure
**Cause:** Hash computation error during `stampExistingRecords` migration  
**Detection:** Migration throws exception before completion  
**Behavior:**
- Migration transaction rolls back
- Database remains in pre-migration state
- Deployment halts (CI/CD gate)

**Recovery:**
```bash
# Run migration in repair mode (skips already-stamped records)
npm run migration:run -- --repair
```

### Reorg Handling

#### Pre-Reorg State
```
Block 100: EvidenceRegistered(claimId=0x123, digest=0xabc)
  → ProjectEvidenceVersion(version=1, blockNumber=100, integrityHash=H1)
  
Block 105: EvidenceReplaced(claimId=0x123, digest=0xdef)
  → ProjectEvidenceVersion(version=2, blockNumber=105, integrityHash=H2, previousVersionHash=H1)
```

#### Reorg Scenario (Block 105 Orphaned)
```
New canonical chain has different EvidenceReplaced at block 106:
Block 106: EvidenceReplaced(claimId=0x123, digest=0xghi)
```

#### Projector Behavior
1. **Detection:** Canonical event at block 106 ≠ existing version 2 at block 105
2. **Rollback:** Delete versions with `blockNumber > 100` (last finalized block)
3. **Re-project:** Apply new event at block 106
   - New version 2 created with different `contentDigest`, `blockNumber`, `eventTxHash`
   - New `integrityHash` computed (deterministically different from orphaned H2)
   - `previousVersionHash` still links to H1 (version 1 unchanged)
4. **Verification:** Chain-of-custody remains intact (H1 → new H2)

**Key Invariant:** Finalized blocks (>12 confirmations on Optimism) are never rolled back. Only unfinalized projections may be replaced.

### Cache Consistency

#### Current State (No Redis Caching)
- All evidence queries hit PostgreSQL directly
- No cache invalidation concerns

#### Future Cache Integration (If Added)
```typescript
// Cache key includes integrity hash
const cacheKey = `evidence:${evidenceId}:${integrityHash}`;

// Cache invalidation on new version
await redis.del(`evidence:${evidenceId}:*`);

// Cache validation on read
const cached = await redis.get(cacheKey);
if (cached && cached.integrityHash === currentHash) {
  return cached;
}
// Otherwise, fetch from DB and verify
```

**Required:** Any future caching MUST include `integrityHash` in cache keys to prevent serving stale/corrupted data.

## API Extensions

### Integrity Verification Endpoints

#### GET /v2/evidence/:evidenceId/integrity
**Purpose:** Verify integrity of a single evidence item and all its versions

**Response:**
```json
{
  "evidenceId": "0x123...",
  "currentVersion": 3,
  "integrityStatus": "valid" | "invalid" | "partial",
  "currentStateIntegrity": {
    "valid": true,
    "hash": "abc123...",
    "verifiedAt": "2026-09-24T10:00:00Z"
  },
  "versionIntegrity": [
    {
      "version": 1,
      "valid": true,
      "hash": "def456...",
      "previousHash": null,
      "blockNumber": "100"
    },
    {
      "version": 2,
      "valid": true,
      "hash": "ghi789...",
      "previousHash": "def456...",
      "blockNumber": "105"
    },
    {
      "version": 3,
      "valid": false,
      "reason": "hash_mismatch",
      "expected": "jkl012...",
      "actual": "xyz999...",
      "blockNumber": "110"
    }
  ],
  "chainOfCustody": {
    "valid": true,
    "brokenAt": null
  }
}
```

**Error States:**
- `404` - Evidence not found
- `500` - Integrity verification failed (internal error)

#### POST /v2/evidence/verify-batch
**Purpose:** Batch verify multiple evidence items

**Request:**
```json
{
  "evidenceIds": ["0x123...", "0x456..."],
  "includeVersions": true
}
```

**Response:**
```json
{
  "results": [
    { "evidenceId": "0x123...", "valid": true },
    { "evidenceId": "0x456...", "valid": false, "reason": "chain_break" }
  ],
  "summary": {
    "total": 2,
    "valid": 1,
    "invalid": 1
  }
}
```

#### GET /v2/health/evidence-integrity
**Purpose:** Continuous integrity monitoring for ops dashboards

**Response:**
```json
{
  "status": "healthy" | "degraded" | "critical",
  "totalEvidence": 1500,
  "integrityChecked": 1500,
  "integrityValid": 1498,
  "integrityInvalid": 2,
  "lastVerificationRun": "2026-09-24T09:00:00Z",
  "invalidEvidence": [
    { "evidenceId": "0x789...", "reason": "hash_mismatch" }
  ]
}
```

### Background Verification Job

```typescript
@Cron('0 */6 * * *') // Every 6 hours
async verifyAllEvidenceIntegrity() {
  const pageSize = 100;
  let cursor = null;
  let invalidCount = 0;
  
  while (true) {
    const evidence = await this.evidenceRepo.find({
      take: pageSize,
      skip: cursor,
      order: { createdAt: 'ASC' }
    });
    
    if (evidence.length === 0) break;
    
    for (const item of evidence) {
      const result = await this.verifyIntegrity(item.evidenceId);
      if (!result.valid) {
        invalidCount++;
        this.logger.error('Integrity failure', {
          evidenceId: item.evidenceId,
          reason: result.reason
        });
        // Trigger alert
        await this.alertService.sendCritical({
          type: 'EVIDENCE_INTEGRITY_FAILURE',
          evidenceId: item.evidenceId,
          details: result
        });
      }
    }
    
    cursor += pageSize;
  }
  
  this.metrics.recordGauge('evidence.integrity.invalid', invalidCount);
}
```

## Migration Strategy

### Phase 1: Schema Migration (Backward Compatible)
```sql
-- Add nullable integrity hash columns
ALTER TABLE v2_project_evidence_version
  ADD COLUMN integrity_hash VARCHAR(64) NULL,
  ADD COLUMN previous_version_hash VARCHAR(64) NULL;

ALTER TABLE v2_project_evidence
  ADD COLUMN integrity_hash VARCHAR(64) NULL;

-- Create indexes for verification queries
CREATE INDEX idx_v2_evidence_version_integrity 
  ON v2_project_evidence_version(evidence_id, version, integrity_hash);

CREATE INDEX idx_v2_evidence_integrity 
  ON v2_project_evidence(evidence_id, integrity_hash);
```

### Phase 2: Backfill Existing Records
```typescript
async stampExistingRecords() {
  // Stamp versions in order (oldest first) to ensure correct previousVersionHash
  const versions = await this.versionRepo.find({
    where: { integrityHash: IsNull() },
    order: { evidenceId: 'ASC', version: 'ASC' }
  });
  
  let previousHash: string | null = null;
  let currentEvidenceId: string | null = null;
  
  for (const version of versions) {
    // Reset previousHash when switching to new evidence
    if (version.evidenceId !== currentEvidenceId) {
      previousHash = null;
      currentEvidenceId = version.evidenceId;
    }
    
    version.previousVersionHash = previousHash;
    const hash = this.integrityService.computeVersionHash(version);
    version.integrityHash = hash;
    await this.versionRepo.save(version);
    
    previousHash = hash; // Chain for next version
  }
  
  // Stamp current-state projections
  const evidence = await this.evidenceRepo.find({
    where: { integrityHash: IsNull() }
  });
  
  for (const item of evidence) {
    const hash = this.integrityService.computeEvidenceHash(item);
    item.integrityHash = hash;
    await this.evidenceRepo.save(item);
  }
}
```

### Phase 3: Enforcement (Make Non-Nullable)
```sql
-- After confirming all records have hashes
UPDATE v2_project_evidence_version 
  SET integrity_hash = 'MIGRATION_FAILED'
  WHERE integrity_hash IS NULL;

UPDATE v2_project_evidence
  SET integrity_hash = 'MIGRATION_FAILED'
  WHERE integrity_hash IS NULL;

-- Make columns NOT NULL
ALTER TABLE v2_project_evidence_version
  ALTER COLUMN integrity_hash SET NOT NULL;

ALTER TABLE v2_project_evidence
  ALTER COLUMN integrity_hash SET NOT NULL;

-- Add CHECK constraints to prevent placeholder values
ALTER TABLE v2_project_evidence_version
  ADD CONSTRAINT chk_v2_evidence_version_hash_valid
  CHECK (integrity_hash != 'MIGRATION_FAILED' AND LENGTH(integrity_hash) = 64);

ALTER TABLE v2_project_evidence
  ADD CONSTRAINT chk_v2_evidence_hash_valid
  CHECK (integrity_hash != 'MIGRATION_FAILED' AND LENGTH(integrity_hash) = 64);
```

## Testing Requirements

### Unit Tests
```typescript
describe('EvidenceIntegrityService', () => {
  it('should compute deterministic hash for version');
  it('should compute deterministic hash for evidence');
  it('should handle null fields in hash computation');
  it('should produce different hashes for different content');
  it('should verify valid integrity hash');
  it('should detect hash mismatch');
  it('should detect missing hash');
  it('should validate chain of custody');
  it('should detect broken chain');
});
```

### Integration Tests
```typescript
describe('Evidence Projector with Integrity', () => {
  it('should stamp integrity hash when projecting EvidenceRegistered');
  it('should chain previousVersionHash for EvidenceReplaced');
  it('should rollback on hash computation failure');
  it('should handle duplicate event replay idempotently');
  it('should rebuild integrity chain after reorg');
  it('should detect corrupted evidence during projection');
});
```

### Regression Tests
```typescript
describe('Protocol Compatibility', () => {
  it('should produce same final state with/without integrity checking');
  it('should not modify canonical event processing logic');
  it('should preserve existing evidence query behavior');
  it('should maintain backward compatibility with pre-hash records');
});
```

## Security Considerations

### Threat Model

| Threat | Mitigation | Detection |
|--------|-----------|-----------|
| Database corruption (hardware) | Integrity hash mismatch | Background verification job |
| Unauthorized direct DB writes | Integrity hash mismatch | Projector pre-flight check |
| Replay attack (duplicate events) | Unique constraint + hash chain | Duplicate event detection |
| Reorg without rollback | Block number consistency check | Projector cursor validation |
| Hash computation DoS | Rate limiting + timeout | Projector performance monitoring |
| Migration corruption | Transaction rollback + repair mode | Migration verification |

### Non-Threats (Out of Scope)

- **IPFS content verification:** `contentDigest` from chain is trusted; we do NOT fetch/verify actual IPFS content
- **Smart contract exploits:** Chain events are assumed authoritative
- **Operator credential compromise:** Access control is a separate concern
- **SQL injection:** TypeORM parameterization already prevents this

## Operational Procedures

### Monitoring Alerts

#### Critical: Integrity Failure Detected
```yaml
alert: EvidenceIntegrityFailure
expr: evidence_integrity_invalid > 0
for: 5m
labels:
  severity: critical
annotations:
  summary: "{{ $value }} evidence records have integrity failures"
  runbook: "docs/runbooks/evidence-integrity-failure.md"
```

#### Warning: Hash Computation Slow
```yaml
alert: EvidenceHashComputationSlow
expr: histogram_quantile(0.95, evidence_hash_computation_duration_seconds) > 1.0
for: 10m
labels:
  severity: warning
annotations:
  summary: "95th percentile hash computation exceeds 1 second"
```

### Recovery Runbook

#### Scenario: Single Evidence Integrity Failure
```bash
# 1. Identify affected evidence
npm run evidence:verify -- --evidence-id <ID>

# 2. Check canonical events
npm run events:list -- --claim-id <ID>

# 3. Rebuild from canonical events
npm run evidence:rebuild -- --evidence-id <ID>

# 4. Re-verify
npm run evidence:verify -- --evidence-id <ID>

# 5. If still invalid, escalate to protocol team
```

#### Scenario: Mass Integrity Failures (Migration Bug)
```bash
# 1. Stop projector
systemctl stop truthbounty-projector

# 2. Rollback to last known-good snapshot
pg_restore -d truthbounty backup_pre_migration.dump

# 3. Fix migration script
git revert <BAD_COMMIT>
npm run migration:run

# 4. Re-stamp all records
npm run evidence:stamp-all -- --verify

# 5. Restart projector
systemctl start truthbounty-projector
```

## Performance Impact

### Hash Computation Cost
- **SHA-256:** ~10 µs per hash on modern CPU
- **Per event:** 2 hashes (version + current state) = ~20 µs
- **Batch (100 events):** ~2 ms additional latency
- **Impact:** <1% overhead on projector throughput

### Storage Cost
- **Per version:** 64 bytes (integrityHash) + 64 bytes (previousVersionHash) = 128 bytes
- **Per evidence:** 64 bytes (integrityHash)
- **For 10,000 evidence items with 2 versions each:**
  - Versions: 10,000 * 2 * 128 bytes = 2.56 MB
  - Evidence: 10,000 * 64 bytes = 640 KB
  - **Total:** ~3.2 MB (negligible)

### Query Performance
- Integrity verification queries use indexed columns (`evidence_id`, `version`)
- Background job processes 100 records/batch (rate-limited)
- No impact on user-facing read queries (integrity check is opt-in)

## Success Criteria

- [ ] Schema migration adds `integrityHash` columns to both entities
- [ ] `EvidenceIntegrityService` computes deterministic, collision-resistant hashes
- [ ] Projector stamps hashes within same transaction as entity persistence
- [ ] Hash computation failures trigger transaction rollback and projector halt
- [ ] Chain-of-custody validation detects broken version chains
- [ ] Integrity verification endpoints return actionable diagnostics
- [ ] Background verification job runs continuously without performance degradation
- [ ] Reorg scenarios correctly rebuild integrity chain
- [ ] Unit tests cover all hash computation edge cases
- [ ] Integration tests verify transaction rollback on hash failure
- [ ] Regression tests prove no change to canonical event processing semantics
- [ ] Migration backfills existing records without data loss
- [ ] Operator runbook documents recovery procedures
- [ ] CI passes lint, typecheck, build, tests, security scan, migration check

## References

- **V2-BE-011:** Canonical Event Store (prerequisite)
- **V2-BE-118:** Contract ABI/Address Artifacts (dependency)
- **Audit Hash Pattern:** `src/audit/utils/integrity.ts`
- **Reorg Handling:** `ARCHITECTURE.md`, `test/reorg-integration.e2e-spec.ts`
- **Chain Authority Principle:** `docs/BACKEND_DOCUMENTATION.md`

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-09-24 | Backend Team | Initial design |
