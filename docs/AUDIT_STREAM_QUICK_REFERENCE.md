# Audit Stream Quick Reference

## Basic Usage

### Appending Records

```typescript
import { AuditStreamService } from '@audit/stream/services/audit-stream.service';

// Inject the service
constructor(private auditStream: AuditStreamService) {}

// Append to a stream
const result = await this.auditStream.append('claim-123', {
  action: 'CLAIM_UPDATED',
  claimId: 'claim-123',
  status: 'VERIFIED',
  evidence_count: 5,
});

console.log(result);
// { streamId: 'claim-123', sequence: 42, hash: 'abc123...' }
```

### Creating Checkpoints

```typescript
const checkpoint = await this.auditStream.createCheckpoint('claim-123');

console.log(checkpoint);
// { streamId: 'claim-123', sequence: 42, headHash: 'abc123...', 
//   keyId: 'key-2024-01', createdAt: Date }
```

### Verifying Chain Integrity

```typescript
const result = await this.auditStream.verifyChain('claim-123');

if (!result.valid) {
  console.log('Chain integrity violation:');
  result.errors.forEach(err => {
    console.log(`  Sequence ${err.details?.sequenceValid ? 'OK' : 'FAIL'}: ${err.reason}`);
  });
}
```

### Exporting for External Verification

```typescript
const { checkpoint, records } = await this.auditStream.exportCheckpointForVerification('claim-123');

// Send checkpoint and records to external verifier
await externalVerificationService.verify({
  checkpoint,
  records,
});
```

## Configuration

### Required Environment Variables

```bash
# Active HMAC key (must exist in secrets/vault)
export AUDIT_ACTIVE_KEY_ID=key-2024-01

# Key material (use secret management, not version control)
export AUDIT_HMAC_KEY_key-2024-01="<64+ random hex characters>"

# Production enforcement
export NODE_ENV=production
```

### Key Rotation

```typescript
// Add new key material to secrets first
export AUDIT_HMAC_KEY_key-2024-02="<new 64+ random hex characters>"

// Then rotate
await keyRegistry.rotateKey('key-2024-02');

// Log this action for compliance
this.auditLog.log({
  actionType: 'KEY_ROTATED',
  details: { from: 'key-2024-01', to: 'key-2024-02' },
});
```

### Key Revocation

```typescript
// Mark a key as revoked (all new records use active key)
await keyRegistry.revokeKey('key-2024-01');

// Historical records with key-2024-01 still verify correctly
// But key-2024-01 cannot be used for new appends
```

## Production Checklist

- [ ] Database is configured and migrated
- [ ] `AUDIT_ACTIVE_KEY_ID` set in secrets
- [ ] `AUDIT_HMAC_KEY_<keyId>` provisioned in vault
- [ ] `NODE_ENV=production` forces DurableAuditStreamStore
- [ ] Startup will fail if any requirement is missing
- [ ] Checkpoint creation is scheduled (e.g., hourly)
- [ ] Verification runs periodically to detect tampering
- [ ] Key rotation procedure is documented
- [ ] Recovery from checkpoint is tested
- [ ] External verification tooling is in place

## Troubleshooting

### "No active audit key configured"

**Problem**: Startup error saying no active key found.

**Solution**:
1. Set `AUDIT_ACTIVE_KEY_ID` environment variable
2. Ensure `AUDIT_HMAC_KEY_<keyId>` is in secrets (not version control)
3. Run migrations to initialize key metadata table

```bash
npm run migrate
export AUDIT_ACTIVE_KEY_ID=key-2024-01
export AUDIT_HMAC_KEY_key-2024-01=<secret>
npm run start
```

### "Chain continuity violation: expected previousHash X, got Y"

**Problem**: Append fails with hash mismatch.

**Solution**:
1. Verify no concurrent appends to same streamId (should serialize)
2. Check that stream wasn't corrupted or replayed
3. Use `verifyChain()` to find exactly which record is invalid

```typescript
const errors = await auditStream.verifyChain('stream-id');
errors.forEach(e => console.log(e.reason));
```

### "Production mode: initializing DurableAuditStreamStore" but then "InMemoryAuditStreamStore initialized"

**Problem**: Production is falling back to in-memory store (data loss risk).

**Solution**:
1. Check database connection is configured
2. Ensure TypeORM entities are registered
3. Run migrations: `npm run migrate`
4. Check logs for database connection errors

```bash
# Verify database
sqlite3 dev.db ".tables" | grep audit_stream

# Run migrations
npm run typeorm migration:run

# Restart
npm run start
```

### "Cannot verify signature for record X: key Y not found"

**Problem**: Record signed with key that's no longer in metadata.

**Solution**:
1. Check if key was deleted (should never happen for audit)
2. Restore key metadata from backup
3. Contact security team if key rotation was lost

```typescript
const validKeys = await keyRegistry.listValidKeys('stream-id');
console.log('Available keys:', validKeys.map(k => k.keyId));
```

## Performance Notes

- **Append latency**: 1-5ms per record (database write + HMAC)
- **Chain verification**: O(n) where n = number of records; cache verification results
- **Checkpoint creation**: ~10ms (single transaction write)
- **Export for verification**: ~100ms for 1000 records (stream all data)

For high-frequency streams (>1000 records/min), consider:
1. Creating checkpoints less frequently (batch verification)
2. Using external indexing for queries
3. Implementing read replicas for verification queries

## Examples

### Audit a Claim Lifecycle

```typescript
const claimId = 'claim-abc123';

// Step 1: Create
await auditStream.append(claimId, {
  action: 'CLAIM_CREATED',
  status: 'PENDING',
  amount: 100,
});

// Step 2: Update
await auditStream.append(claimId, {
  action: 'EVIDENCE_SUBMITTED',
  evidence_id: 'evidence-xyz',
  evidence_count: 1,
});

// Step 3: Verify
await auditStream.append(claimId, {
  action: 'VERIFICATION_COMPLETED',
  status: 'VERIFIED',
});

// Step 4: Checkpoint
const checkpoint = await auditStream.createCheckpoint(claimId);

// Export for external audit
const { checkpoint, records } = await auditStream.exportCheckpointForVerification(claimId);
// Send to compliance team
```

### Verify After Restart

```typescript
// After deployment/restart, verify all streams are intact
const streamIds = ['claim-1', 'claim-2', 'claim-3'];

for (const streamId of streamIds) {
  const result = await auditStream.verifyChain(streamId);
  if (!result.valid) {
    logger.error(`ALERT: Stream ${streamId} failed verification`, result.errors);
  }
}
```

### Rotate Keys Safely

```typescript
logger.log('Starting key rotation');

// 1. Add new key to secrets (before this step)
// 2. Create metadata for new key
await keyRegistry.rotateKey('key-2024-02');

// 3. All new appends use key-2024-02
// 4. Old records signed with key-2024-01 still verify

logger.log('Key rotated to key-2024-02');

// 5. After retention period, revoke old key
await keyRegistry.revokeKey('key-2024-01');

logger.log('Old key revoked');
```
