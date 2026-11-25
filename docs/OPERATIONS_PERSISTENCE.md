# Operations Persistence: Durable Idempotency and Audit

**Issue**: PREWAVE-BE-110 (#811)  
**Status**: ✅ Implemented  
**Last Updated**: 2026-11-21

## Overview

This document describes the durable persistence layer for operational retry idempotency keys and audit records, replacing the process-local in-memory storage with database-backed stores shared across API replicas.

## Problem Statement

Previously, `OperationsService` stored idempotency-key outcomes in a process-local `Map`, while `InMemoryOperationsAuditStore` stored audit records in a bounded in-memory cache. This caused:

- **Lost retry outcomes** after process restarts or across multiple API replicas
- **Duplicate retry execution** when the same idempotency key was submitted to different replicas
- **Missing audit trail** for compliance and forensic reconstruction after restarts
- **Inconsistent behavior** in multi-replica deployments

## Solution Architecture

### Database Tables

Two new tables provide durable persistence:

#### `operations_idempotency_keys`

Stores idempotency keys with cached retry outcomes. Records expire after a configurable TTL (default: 24 hours).

**Schema**:
```sql
CREATE TABLE operations_idempotency_keys (
  key VARCHAR(256) PRIMARY KEY,
  itemId VARCHAR(128) NOT NULL,
  actorId UUID,
  capability VARCHAR(128) NOT NULL,
  authoritySource VARCHAR(64) NOT NULL,
  authorityExpiresAt TIMESTAMPTZ,
  outcome JSONB NOT NULL,
  createdAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiresAt TIMESTAMPTZ NOT NULL,
  
  CHECK (expiresAt > createdAt)
);
```

**Indexes**:
- `idx_ops_idem_expires` on `(expiresAt)` — for cleanup queries
- `idx_ops_idem_item` on `(itemId)` — for item-based queries
- `idx_ops_idem_actor_created` on `(actorId, createdAt)` — for actor audit

#### `operations_audit_logs`

Stores immutable audit records for all retry requests (accepted and rejected). Records are retained for a configurable period (default: 90 days).

**Schema**:
```sql
CREATE TABLE operations_audit_logs (
  auditId UUID PRIMARY KEY,
  action VARCHAR(128) NOT NULL,
  capability VARCHAR(128) NOT NULL,
  authoritySource VARCHAR(64) NOT NULL,
  actorId UUID,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  resultCode VARCHAR(64) NOT NULL,
  subjectId VARCHAR(128),
  createdAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retentionUntil TIMESTAMPTZ NOT NULL,
  
  CHECK (retentionUntil >= createdAt)
);
```

**Indexes**:
- `idx_ops_audit_actor_time` on `(actorId, createdAt)` — for actor activity queries
- `idx_ops_audit_subject` on `(subjectId)` — for item history queries
- `idx_ops_audit_outcome_time` on `(outcome, createdAt)` — for failure analysis
- `idx_ops_audit_retention` on `(retentionUntil)` — for cleanup queries

### Implementation Components

#### 1. DurableOperationsIdempotencyStore

**Location**: `src/operations/operations-idempotency.store.ts`

Provides:
- `check(key)` — Check if idempotency key exists and return cached outcome
- `save(input, manager)` — Save key+outcome within a transaction
- `cleanupExpired()` — Delete expired keys (TTL-based)

**Key Behavior**:
- Duplicate keys are rejected at database level (primary key constraint)
- Race conditions between replicas result in constraint violations
- Second writer fetches and replays cached outcome
- Default TTL: 24 hours (configurable per-key)

#### 2. DurableOperationsAuditStore

**Location**: `src/operations/operations-audit.store.ts`

Provides:
- `save(record, manager)` — Save audit record within a transaction
- `get(auditId)` — Retrieve audit record by ID
- `cleanupExpired()` — Delete records past retention period

**Key Behavior**:
- Records are **immutable** once written (no UPDATE support)
- All fields are sanitized (no PII, secrets, or credentials)
- Default retention: 90 days (configurable per-record)
- Deletion only via retention cleanup or legal hold override

#### 3. OperationsService (Refactored)

**Location**: `src/operations/operations.service.ts`

**Transaction Flow**:

```typescript
async submitRetry(input) {
  // 1. Check idempotency BEFORE transaction (fast-path replay)
  if (input.idempotencyKey) {
    const check = await idempotencyStore.check(input.idempotencyKey);
    if (check.exists) {
      return check.record.outcome; // Replay cached result
    }
  }

  // 2. Validate authority, precondition, business rules (fail-closed)
  const item = await source.get(input.id);
  this.revalidateAuthority(auditId, item, input);
  // ... additional validations

  // 3. Execute retry + persist in ONE transaction
  return await dataSource.transaction(async (manager) => {
    const result = await source.retry(item.id, options);
    
    const submission = { id, accepted: true, auditId, ...result };
    
    // Save idempotency key with outcome
    if (input.idempotencyKey) {
      await idempotencyStore.save({ key, itemId, outcome: submission }, manager);
    }
    
    // Save audit record
    await auditStore.save(auditRecord, manager);
    
    return submission;
  });
}
```

**Transaction Guarantees**:
- Idempotency key + audit record + queue update are **atomic**
- Crash before commit → all writes rolled back, no side effects
- Crash after commit → idempotency key + audit trail are durable
- Constraint violation on duplicate key → fetch and replay cached outcome

#### 4. OperationsRetentionService

**Location**: `src/operations/operations-retention.service.ts`

Scheduled cleanup service (`@Cron`, default: 2 AM daily):

```typescript
@Cron(CronExpression.EVERY_DAY_AT_2AM)
async scheduledCleanup() {
  const deletedKeys = await idempotencyStore.cleanupExpired();
  const deletedAudit = await auditStore.cleanupExpired();
}
```

**Configuration**:
- `OPERATIONS_CLEANUP_CRON` — Cron schedule (default: `0 2 * * *`)
- TTL and retention are per-record, not globally configurable

## Transaction Boundaries

### Retry Submission (Happy Path)

```
┌─────────────────────────────────────────────────────────────┐
│ dataSource.transaction(async (manager) => {                 │
│                                                              │
│   1. source.retry(itemId) → Update v2_outbox_messages       │
│   2. idempotencyStore.save(key, outcome, manager)           │
│   3. auditStore.save(auditRecord, manager)                  │
│                                                              │
│   COMMIT → All 3 writes become durable atomically           │
│ })                                                           │
└─────────────────────────────────────────────────────────────┘
```

### Rejection Path (Pre-Transaction)

Rejections that occur before the main transaction (e.g., item not found, idempotency conflict) save the audit record in a separate transaction:

```
┌─────────────────────────────────────────────────────────────┐
│ dataSource.transaction(async (manager) => {                 │
│   auditStore.save(rejectionRecord, manager)                 │
│   COMMIT                                                     │
│ })                                                           │
│ throw OperationsError(...)                                  │
└─────────────────────────────────────────────────────────────┘
```

This is acceptable because no queue state change occurs for rejections.

## Concurrency and Replica Safety

### Scenario: Two Replicas Submit Same Idempotency Key

**Timeline**:

1. **Replica A** checks idempotency store → key not found
2. **Replica B** checks idempotency store → key not found
3. **Replica A** starts transaction, calls `source.retry()`, saves key
4. **Replica B** starts transaction, calls `source.retry()`, tries to save key
5. **Replica A** commits → key+audit+queue update are durable
6. **Replica B** gets constraint violation on duplicate key
7. **Replica B** catches error, fetches cached outcome, returns it

**Result**: Only one retry executes; both callers get consistent outcome.

### Scenario: Crash During Transaction

**Before Commit**:
- Transaction rolls back
- No idempotency key, audit record, or queue update persists
- Caller receives error (timeout or connection lost)
- Safe to retry: next submission will execute as if first attempt never happened

**After Commit**:
- Idempotency key + audit record + queue update are all durable
- Caller may or may not receive response (depends on network timing)
- Safe to retry: duplicate key will replay cached outcome

## Security and Privacy

### Sanitization Contract

**Idempotency Keys**:
- ✅ Store: `actorId` (UUID), `capability`, `authoritySource`, `authorityExpiresAt`
- ✅ Store: `outcome` (submission result with counts, no internal details)
- ❌ Never store: PII, credentials, authorization headers, internal topology

**Audit Records**:
- ✅ Store: `actorId` (UUID), `action`, `capability`, `outcome`, `resultCode`, `subjectId`
- ❌ Never store: PII, private keys, secrets, stack traces, raw error messages

### Immutability

Audit records are **write-once**:
- No UPDATE or DELETE except via retention cleanup
- Production deployments SHOULD enforce this with database triggers or RLS policies

### Retention and Compliance

**Idempotency Keys**:
- Default TTL: **24 hours**
- Rationale: Prevents replay attacks during retry windows while keeping table bounded
- Cleanup: Automatic via `OperationsRetentionService`

**Audit Records**:
- Default retention: **90 days**
- Rationale: Compliance, forensics, security review
- Cleanup: Automatic via `OperationsRetentionService`
- Legal hold: Override `retentionUntil` for specific records

## Operational Procedures

### Manual Cleanup Trigger

```bash
# Via NestJS CLI or admin API
curl -X POST /internal/operations/retention/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns:
```json
{
  "deletedKeys": 1234,
  "deletedAuditRecords": 5678,
  "timestamp": "2026-11-21T10:00:00.000Z"
}
```

### Monitoring Queries

**Check idempotency key distribution**:
```sql
SELECT 
  DATE_TRUNC('hour', "createdAt") AS hour,
  COUNT(*) AS keys_created
FROM operations_idempotency_keys
WHERE "createdAt" > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

**Check audit record outcome distribution**:
```sql
SELECT 
  outcome,
  "resultCode",
  COUNT(*) AS count
FROM operations_audit_logs
WHERE "createdAt" > NOW() - INTERVAL '7 days'
GROUP BY outcome, "resultCode"
ORDER BY count DESC;
```

**Find expired keys not yet cleaned up**:
```sql
SELECT COUNT(*) AS expired_keys
FROM operations_idempotency_keys
WHERE "expiresAt" < NOW();
```

### Troubleshooting

#### Problem: Idempotency key conflicts increasing

**Symptoms**: High rate of `CONFLICT` errors with `Idempotency-Key was already used`

**Diagnosis**:
```sql
SELECT "itemId", COUNT(*) AS conflicts
FROM operations_idempotency_keys
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
GROUP BY "itemId"
HAVING COUNT(*) > 1
ORDER BY conflicts DESC;
```

**Resolution**:
- Check if clients are generating duplicate keys
- Verify TTL is sufficient for retry windows
- Review application logs for constraint violation patterns

#### Problem: Audit table growing without bound

**Symptoms**: Table size exceeding disk capacity, slow queries

**Diagnosis**:
```sql
SELECT 
  COUNT(*) AS total_records,
  COUNT(*) FILTER (WHERE "retentionUntil" < NOW()) AS expired_records,
  pg_size_pretty(pg_total_relation_size('operations_audit_logs')) AS table_size
FROM operations_audit_logs;
```

**Resolution**:
- Verify `OperationsRetentionService` is running (check scheduler logs)
- Manually trigger cleanup: `operationsRetentionService.manualCleanup()`
- Review `retentionUntil` distribution for stuck records

#### Problem: Transaction deadlocks

**Symptoms**: Occasional `deadlock detected` errors in logs

**Diagnosis**:
```sql
SELECT * FROM pg_stat_activity
WHERE state = 'active' AND query LIKE '%operations_%';
```

**Resolution**:
- Ensure all writes use the same lock order (key → audit → queue)
- Avoid long-running transactions in retry logic
- Check for external locks on `v2_outbox_messages` table

## Testing

### Unit Tests

**Location**: `src/operations/operations.service.spec.ts`

Covers service-level idempotency, authority validation, precondition checks using in-memory stores.

### Integration Tests

**Location**: `src/operations/operations-persistence.spec.ts`

Covers:
- ✅ Idempotency key save/retrieve/check
- ✅ Constraint violation on duplicate keys
- ✅ Simulated restart (new store instance fetches persisted data)
- ✅ TTL-based cleanup
- ✅ Audit record save/retrieve
- ✅ Immutability verification
- ✅ Retention-based cleanup
- ✅ Transaction atomicity (rollback/commit)

Run with:
```bash
npm test -- operations-persistence.spec.ts
```

## Migration Path

### From In-Memory to Durable Stores

**Before Deployment**:
1. Run migration: `npm run migration:run` (applies `20261121130337_add_operations_persistence`)
2. Verify tables exist: `\dt operations_*` in psql
3. Verify indexes: `\di operations_*`

**Deployment**:
1. Deploy updated code with `OperationsModule` binding durable stores
2. Restart API replicas (zero-downtime: idempotency cache is lost but rebuilt)
3. Monitor for constraint violations (expected during warm-up)

**Rollback**:
1. Revert `OperationsModule` to bind `InMemoryOperationsAuditStore`
2. Redeploy API replicas
3. Idempotency table can remain (cleanup will remove stale keys)

### Backward Compatibility

For testing or development, swap the binding in `OperationsModule`:

```typescript
{
  provide: OPERATIONS_AUDIT_STORE,
  useExisting: InMemoryOperationsAuditStore,  // <-- Use in-memory
}
```

**Note**: `InMemoryOperationsAuditStore` was updated to match the new interface (added `manager` parameter to `save()` and `cleanupExpired()` method) for compatibility.

## Performance Considerations

### Expected Load

- **Idempotency Keys**: ~100-1000/hour per replica (bounded by retry rate)
- **Audit Records**: Same as idempotency keys (1:1 ratio)
- **Cleanup**: Daily cron job deletes ~2400 keys and ~200K audit records (90-day retention)

### Index Usage

All queries use indexes:
- `check(key)` → Primary key lookup (O(1))
- `cleanupExpired()` → Index scan on `expiresAt` or `retentionUntil`
- Actor queries → Composite index on `(actorId, createdAt)`

### Storage Estimates

**Idempotency Keys**:
- Row size: ~500 bytes (including JSONB outcome)
- 24-hour retention × 1000 keys/hour = 24K rows = ~12 MB

**Audit Records**:
- Row size: ~300 bytes
- 90-day retention × 1000 records/hour × 24 hours = 2.16M rows = ~648 MB

## References

- **Issue**: [#811 PREWAVE-BE-110](https://github.com/DigiNodes/truthbounty-api/issues/811)
- **Original Operations Service**: [UX-BE-004, #595](https://github.com/DigiNodes/truthbounty-api/issues/595)
- **Migration File**: `prisma/migrations/20261121130337_add_operations_persistence/migration.sql`
- **TypeORM Entities**: `src/operations/entities/`
- **Stores**: `src/operations/operations-idempotency.store.ts`, `operations-audit.store.ts`
- **Cleanup**: `src/operations/operations-retention.service.ts`

---

**Document Maintenance**: Update this document when changing retention policies, adding new indexes, or modifying transaction boundaries.
