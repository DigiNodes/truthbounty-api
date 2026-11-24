# Audit Stream Operations Runbook

## Startup Procedures

### Initial Setup

1. **Database Migration**
   ```bash
   npm run migrate
   ```
   Creates tables: `audit_stream_records`, `audit_stream_checkpoints`, `audit_key_metadata`

2. **Generate Initial HMAC Key**
   ```bash
   # Generate 32 random bytes → 64 hex chars
   openssl rand -hex 32
   ```

3. **Configure Secrets** (never in .env files or version control)
   ```bash
   # In your vault/secrets manager:
   export AUDIT_ACTIVE_KEY_ID=key-2024-01
   export AUDIT_HMAC_KEY_key-2024-01=<64-hex-chars-from-above>
   export NODE_ENV=production
   ```

4. **Start Service**
   ```bash
   npm run start
   ```
   Should log: `Loaded active audit key: key-2024-01`

### Verification After Startup

```bash
# Check application logs for:
# "[AuditStreamModule] Production mode: initializing DurableAuditStreamStore"
# "[AuditStreamModule] AuditStreamModule initialized with DurableAuditStreamStore"

# If you see:
# "[InMemoryAuditStreamStore] InMemoryAuditStreamStore initialized..."
# → CRITICAL: Production is using in-memory store (data loss risk)
#   Check database configuration and restart
```

## Daily Operations

### Scheduled Checkpoint Creation

Create checkpoints periodically to enable fast recovery and verification:

```bash
# Example: Create checkpoint every hour
# (Add to your cron scheduler or Kubernetes CronJob)

# Option 1: Via API (if implemented)
POST /api/audit/stream/claim-123/checkpoint

# Option 2: Via Admin Script
node scripts/create-audit-checkpoints.js

# Option 3: Scheduled Service
# Add to src/audit/stream/services/checkpoint-scheduler.service.ts
@Cron(CronExpression.EVERY_HOUR)
async createHourlyCheckpoints() {
  const streams = await this.getActiveStreams();
  for (const streamId of streams) {
    await this.auditStream.createCheckpoint(streamId);
  }
}
```

### Regular Chain Verification

Detect tampering early:

```bash
# Example: Verify all streams every 6 hours

@Cron(CronExpression.EVERY_6_HOURS)
async verifyAllStreams() {
  const streams = await this.getStreamIds();
  for (const streamId of streams) {
    const result = await this.auditStream.verifyChain(streamId);
    if (!result.valid) {
      this.logger.error(`ALERT: Stream ${streamId} verification failed:`, result.errors);
      // Send alert to security team
      await alertingService.sendSecurityAlert({
        severity: 'HIGH',
        message: `Audit stream ${streamId} failed integrity check`,
        details: result.errors,
      });
    }
  }
}
```

### Monitor Key Expiration

Track when old keys are no longer needed:

```bash
# Query: Find oldest checkpoint
SELECT MIN(createdAt) FROM audit_stream_checkpoints;

# Query: Find keys older than oldest checkpoint
SELECT * FROM audit_key_metadata 
WHERE revokedAt < (SELECT MIN(createdAt) FROM audit_stream_checkpoints)
  AND revokedAt IS NOT NULL;

# These keys can be deleted (after 90-day retention period)
```

## Key Rotation

### Pre-Rotation Checklist

- [ ] Generate new 32-byte random key: `openssl rand -hex 32`
- [ ] Store in vault/secrets manager under `AUDIT_HMAC_KEY_key-2024-02`
- [ ] Notify compliance/audit team (key rotation event)
- [ ] Schedule rotation during low-traffic window (optional)

### Rotation Steps

1. **Update Secrets Manager**
   ```bash
   vault kv put secret/audit AUDIT_HMAC_KEY_key-2024-02=<new-key-hex>
   ```

2. **Trigger Rotation** (via API or service call)
   ```typescript
   await keyRegistry.rotateKey('key-2024-02');
   ```

3. **Verify Rotation**
   ```bash
   # Query database
   SELECT keyId, isActive FROM audit_key_metadata 
   WHERE algorithm = 'HMAC-SHA256'
   ORDER BY createdAt DESC;

   # Should show:
   # key-2024-02 | 1 (active)
   # key-2024-01 | 0 (inactive)
   ```

4. **Log Rotation Event**
   ```typescript
   await auditLog.log({
     actionType: 'SYSTEM_AUDIT_KEY_ROTATED',
     description: 'Rotated audit HMAC key from key-2024-01 to key-2024-02',
     metadata: {
       oldKey: 'key-2024-01',
       newKey: 'key-2024-02',
     },
   });
   ```

5. **Verify All Streams**
   ```bash
   # Run chain verification on all active streams
   node scripts/verify-audit-streams.js
   
   # Should show: All streams valid
   ```

### Post-Rotation Monitoring

```bash
# Monitor for 24 hours
# Check for any verification failures
# If failures: immediately revoke and rollback

# After 24 hours of success:
# Mark old key for revocation
await keyRegistry.revokeKey('key-2024-01');

# After retention period (e.g., 90 days):
# Delete old key metadata (optional, keep for compliance)
DELETE FROM audit_key_metadata 
WHERE keyId = 'key-2024-01' 
  AND revokedAt < NOW() - INTERVAL 90 DAY;
```

## Emergency Procedures

### Chain Integrity Violation Detected

**Alert**: "Audit stream X failed integrity check"

**Diagnosis**:
```bash
# Get detailed errors
SELECT * FROM audit_stream_records 
WHERE streamId = 'problematic-stream' 
ORDER BY sequence;

# Check signatures
SELECT sequence, keyId, hmacSignature, payloadHash 
FROM audit_stream_records 
WHERE streamId = 'problematic-stream' 
ORDER BY sequence;

# Identify problematic record
# (The one where previousHash doesn't match prior record's payloadHash)
```

**Recovery**:

If tampering is confirmed:

1. **Isolate**: Stop accepting new records for affected stream
2. **Notify**: Alert security and compliance teams
3. **Investigate**: Determine root cause (compromised key, database corruption, etc.)
4. **Recover**: Create new checkpoint from last known-good state
5. **Audit**: Review all records since last checkpoint
6. **Rotate**: If key is suspected compromised, rotate immediately
7. **Resume**: Once root cause is fixed, resume normal operations

### Database Corruption

**Symptom**: "Unique constraint violation" on sequence insert or "Checkpoint not found" errors

**Recovery**:

1. **Stop service**
2. **Create backup**: `sqlite3 dev.db ".backup ./backup.db"`
3. **Restore from last clean state**:
   ```bash
   sqlite3 dev.db < ./last-known-good.sql
   ```
4. **Re-verify chain**: Run verification on all streams
5. **Restart service**

### Key Material Lost/Corrupted

**Symptom**: "No active audit key available" or key lookup fails

**Recovery**:

1. **Check Secrets Manager**
   ```bash
   vault kv list secret/audit
   vault kv get secret/audit
   ```

2. **If key exists in vault**: Restart service (will reload from vault)

3. **If key is missing**:
   - This is a critical incident (crypto keys cannot be recovered)
   - Contact security team
   - Rotate to new key immediately
   - Review all records since key was last active

### High Latency/Performance Degradation

**Diagnosis**:
```bash
# Check database indexes
ANALYZE;
SELECT * FROM sqlite_stat1;

# Check for large transactions
SELECT name, sql FROM sqlite_master 
WHERE type='table' AND name LIKE 'audit_stream%';

# Check record count per stream
SELECT streamId, COUNT(*) as record_count 
FROM audit_stream_records 
GROUP BY streamId 
ORDER BY record_count DESC 
LIMIT 10;
```

**Solutions**:

- **Missing index**: Reapply migration `migration:run`
- **Very large stream**: Create checkpoint and archive old records
- **Database lock**: Restart database connection
- **Disk space**: Check disk usage, clean up old checkpoints if needed

## Monitoring & Alerting

### Key Metrics to Monitor

```bash
# Record append rate (should be stable)
SELECT COUNT(*) as records_per_hour
FROM audit_stream_records
WHERE createdAt > datetime('now', '-1 hour');

# Checkpoint creation frequency
SELECT COUNT(*) as checkpoints_per_day
FROM audit_stream_checkpoints
WHERE createdAt > datetime('now', '-1 day');

# Chain verification success rate
SELECT 
  SUM(CASE WHEN valid THEN 1 ELSE 0 END) as valid_streams,
  COUNT(*) as total_streams
FROM verification_results;

# Active streams
SELECT COUNT(DISTINCT streamId) as active_streams
FROM audit_stream_records;

# Key rotation history
SELECT keyId, createdAt, revokedAt, isActive
FROM audit_key_metadata
ORDER BY createdAt DESC;
```

### Alerting Rules

Configure alerts for:

1. **Chain Verification Failure**
   - Condition: verification_errors > 0
   - Severity: HIGH
   - Action: Page on-call + notify security team

2. **Missing Active Key**
   - Condition: no_active_key_found
   - Severity: CRITICAL
   - Action: Page on-call immediately

3. **High Record Write Latency**
   - Condition: append_latency_p99 > 100ms
   - Severity: MEDIUM
   - Action: Notify platform team

4. **Checkpoint Lag**
   - Condition: now() - latest_checkpoint_time > 2 hours
   - Severity: LOW
   - Action: Notify ops team

## Backups & Disaster Recovery

### Backup Strategy

```bash
# Daily backup of audit tables
0 2 * * * sqlite3 /data/prod.db ".backup /backups/audit-$(date +%Y%m%d).db"

# Keep last 30 days
find /backups -name "audit-*.db" -mtime +30 -delete

# Weekly full backup (encryption recommended)
0 3 * * 0 tar czf /backups/audit-full-$(date +%Y%m%d).tar.gz /data/
```

### Recovery Procedure

1. **Restore database**
   ```bash
   sqlite3 /data/prod.db < /backups/audit-backup.sql
   ```

2. **Verify chain integrity**
   ```bash
   node scripts/verify-audit-streams.js
   ```

3. **Check for data loss**
   - Compare record counts before/after
   - Check latest checkpoint matches expected state
   - Query business logic for consistency

4. **Restart service**
   ```bash
   npm run start
   ```

## Documentation & Compliance

### Audit Trail Events

Log these events separately from audit records:

```typescript
// Key rotation event
await auditLog.log({
  actionType: 'AUDIT_KEY_ROTATED',
  details: { from: 'key-2024-01', to: 'key-2024-02' },
});

// Key revocation event
await auditLog.log({
  actionType: 'AUDIT_KEY_REVOKED',
  details: { revokedKey: 'key-2024-01' },
});

// Verification failure
await auditLog.log({
  actionType: 'AUDIT_CHAIN_VERIFICATION_FAILED',
  details: { streamId, errors },
  severity: 'HIGH',
});

// Checkpoint export
await auditLog.log({
  actionType: 'AUDIT_CHECKPOINT_EXPORTED',
  details: { streamId, sequence },
});
```

### Compliance Reporting

Generate monthly compliance reports:

```bash
# Monthly verification report
SELECT 
  DATE_TRUNC('month', createdAt) as month,
  COUNT(DISTINCT streamId) as streams,
  COUNT(*) as total_records,
  SUM(CASE WHEN verified THEN 1 ELSE 0 END) as verified_records
FROM audit_stream_records
GROUP BY DATE_TRUNC('month', createdAt)
ORDER BY month DESC;

# Key rotation history
SELECT keyId, createdAt, revokedAt, reason
FROM audit_key_metadata
WHERE createdAt > DATE_SUB(NOW(), INTERVAL 1 MONTH)
ORDER BY createdAt DESC;
```

## Contact & Escalation

- **On-Call Engineer**: [PagerDuty alert]
- **Security Team**: [contact info]
- **Database Administrator**: [contact info]
- **Compliance Officer**: [contact info]

## Related Documents

- AUDIT_STREAM_IMPLEMENTATION.md — Technical reference
- AUDIT_STREAM_QUICK_REFERENCE.md — Developer guide
- AUDIT_STREAM_IMPLEMENTATION_SUMMARY.md — Overview
