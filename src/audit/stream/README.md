# Audit Stream Module

Durable, hash-chained audit stream store with tamper-evident records, cryptographic key management, and cross-replica safety.

## Overview

This module provides a production-grade audit stream implementation that:

- **Persists tamper-evident records** in a hash-chain
- **Prevents duplicate appends** via unique (streamId, sequence) constraints
- **Supports key rotation** without invalidating historical records
- **Detects tampering** (7 scenarios: missing records, hash mismatches, gaps, etc.)
- **Creates checkpoints** for recovery and external verification
- **Isolates raw key material** from application code

## Quick Start

### 1. Inject the Service

```typescript
import { AuditStreamService } from '@audit/stream/services/audit-stream.service';

@Injectable()
export class ClaimService {
  constructor(private auditStream: AuditStreamService) {}
}
```

### 2. Append Records

```typescript
const result = await this.auditStream.append('claim-123', {
  action: 'CLAIM_UPDATED',
  status: 'VERIFIED',
  evidence_count: 5,
});

// result = { streamId: 'claim-123', sequence: 42, hash: 'abc123...' }
```

### 3. Create Checkpoints

```typescript
const checkpoint = await this.auditStream.createCheckpoint('claim-123');
// Save checkpoint for recovery/external verification
```

### 4. Verify Chain Integrity

```typescript
const result = await this.auditStream.verifyChain('claim-123');
if (!result.valid) {
  logger.error('Chain integrity violation:', result.errors);
}
```

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────┐
│   AuditStreamService                │  High-level API
│   • append, getHead, createCheckpoint│  • Sanitization, signing
│   • verifyChain, export              │  • Canonical serialization
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   AuditStreamStore (Abstract)       │  Store interface
│   ├─ DurableAuditStreamStore        │  Production: Database
│   └─ InMemoryAuditStreamStore       │  Testing: Memory (dev only)
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   AuditKeyRegistry (Abstract)       │  Key management
│   └─ SecretAuditKeyRegistry         │  HMAC, rotation, revocation
└──────────────┬──────────────────────┘
               │
        ┌──────▼─────────┐
        │  Database      │
        │  + Secrets     │
        └────────────────┘
```

### Hash-Chain Format

```
Record 1: previousHash=0 → payloadHash=hash1 → hmacSignature=sig1(hash1)
Record 2: previousHash=hash1 → payloadHash=hash2 → hmacSignature=sig2(hash2)
Record 3: previousHash=hash2 → payloadHash=hash3 → hmacSignature=sig3(hash3)
         ▲ Each record links to previous payload hash
```

## Configuration

### Environment Variables (Required for Production)

```bash
# Active HMAC key identifier
export AUDIT_ACTIVE_KEY_ID=key-2024-01

# Key material (must be in secrets/vault, not version control)
export AUDIT_HMAC_KEY_key-2024-01="<64+ random hex characters>"

# Enforce production mode
export NODE_ENV=production
```

### Database

Migration creates three tables:
- `audit_stream_records` — Immutable records with hash-chain links
- `audit_stream_checkpoints` — Stream snapshots
- `audit_key_metadata` — Key registry (non-secret)

Run migration:
```bash
npm run migrate
```

## Security

### Design Properties

1. **Immutable records**: Once appended, records cannot be modified
2. **Hash-chain continuity**: Tampering breaks the chain
3. **Cryptographic signatures**: HMAC-SHA256 prevents forgery
4. **Key isolation**: Raw key material never stored in DB or logs
5. **Atomic transactions**: No partial states
6. **Replica safety**: Unique constraints prevent duplicates
7. **Historical verification**: Records remain verifiable after key rotation

### Tamper Detection

The service detects:

1. Missing records (gaps in sequence)
2. Hash mismatches (previousHash != priorRecord.hash)
3. Sequence violations (database constraint)
4. Unknown keys (keyId not in metadata)
5. Revoked keys (flagged for investigation)
6. Signature failures (HMAC recompute mismatch)
7. Checkpoint mismatches (stream state != checkpoint)

### Key Management

- **Rotation**: Old key deactivated, new key activated, all new records use new key
- **Revocation**: Mark key as revoked; prevents new use; allows old record verification
- **Metadata**: Only non-secret metadata persisted (keyId, algorithm, timestamps)
- **Material**: Raw keys loaded from environment secrets only

## Testing

### Test Coverage

- **29+ test cases** covering:
  - Hash-chain linking and integrity
  - Payload sanitization
  - Checkpoint creation and export
  - Chain verification (valid + tampered)
  - Concurrent append safety
  - Key rotation and revocation
  - Database constraint enforcement
  - Error boundaries

### Run Tests

```bash
# All tests
npm run test -- src/audit/stream

# Specific suite
npm run test -- src/audit/stream/tests/audit-stream.integration.spec.ts
```

## Documentation

- **AUDIT_STREAM_IMPLEMENTATION.md** — Technical reference (architecture, format, keys, recovery)
- **AUDIT_STREAM_QUICK_REFERENCE.md** — Operational guide (usage, config, troubleshooting)
- **AUDIT_STREAM_OPERATIONS_RUNBOOK.md** — On-call procedures (startup, rotation, emergency)

## API Reference

### AuditStreamService

```typescript
// Append a record to the stream
append(streamId: string, payload: Record<string, any>): Promise<AuditStreamAppendResult>
  → { streamId, sequence, hash }

// Get the latest record in the stream
getHead(streamId: string): Promise<AuditStreamRecord | null>

// Get a specific record by sequence
getRecord(streamId: string, sequence: number): Promise<AuditStreamRecord | null>

// Create a checkpoint at the current head
createCheckpoint(streamId: string): Promise<AuditStreamCheckpoint>

// Verify chain integrity
verifyChain(streamId: string, upToSequence?: number): Promise<{ valid, errors }>

// Export checkpoint and records for external verification
exportCheckpointForVerification(streamId: string): Promise<{ checkpoint, records }>
```

### SecretAuditKeyRegistry

```typescript
// Get the active key ID
getActiveKey(): Promise<string | null>

// Get key metadata
getKey(keyId: string): Promise<AuditStreamKey | null>

// Rotate to a new key
rotateKey(newKeyId: string): Promise<void>

// Revoke a key
revokeKey(keyId: string): Promise<void>

// List all valid (non-revoked) keys
listValidKeys(streamId: string): Promise<AuditStreamKey[]>
```

## Examples

### Basic Audit Trail

```typescript
const streamId = 'claim-' + claimId;

// Log creation
await auditStream.append(streamId, {
  action: 'CREATED',
  status: 'PENDING',
  amount: 100,
});

// Log update
await auditStream.append(streamId, {
  action: 'UPDATED',
  status: 'VERIFIED',
  evidence_count: 3,
});

// Create checkpoint for recovery
await auditStream.createCheckpoint(streamId);

// Export for external verification
const { checkpoint, records } = await auditStream.exportCheckpointForVerification(streamId);
```

### Key Rotation

```typescript
// 1. Add new key to vault
// 2. Rotate
await keyRegistry.rotateKey('key-2024-02');

// 3. All new records use key-2024-02
// 4. Old records remain verifiable with key-2024-01
// 5. After retention period, revoke old key
await keyRegistry.revokeKey('key-2024-01');
```

### Chain Verification

```typescript
const result = await auditStream.verifyChain('stream-id');

if (!result.valid) {
  for (const error of result.errors) {
    console.log(`Verification error: ${error.reason}`, error.details);
  }
  // Alert security team
}
```

## Performance

- **Append latency**: 1-5ms per record
- **Verification**: O(n) records; cache results for large streams
- **Checkpoint creation**: ~10ms (single transaction)
- **Storage**: ~400 bytes per record + indexes

## Production Checklist

- [ ] Database configured and migrated
- [ ] AUDIT_ACTIVE_KEY_ID set in secrets
- [ ] AUDIT_HMAC_KEY_<keyId> provisioned in vault
- [ ] NODE_ENV=production enforces durable store
- [ ] Checkpoint creation scheduled (hourly/daily)
- [ ] Chain verification runs periodically
- [ ] Key rotation procedure documented
- [ ] Recovery plan tested
- [ ] Monitoring/alerting configured
- [ ] Backup strategy implemented

## Troubleshooting

### "No active audit key configured"

**Problem**: Startup error

**Solution**:
1. Set `AUDIT_ACTIVE_KEY_ID` environment variable
2. Ensure `AUDIT_HMAC_KEY_<keyId>` is in secrets
3. Run migrations: `npm run migrate`

### "Chain continuity violation"

**Problem**: Append fails with hash mismatch

**Solution**:
1. Check no concurrent appends to same stream
2. Run `verifyChain()` to find exactly which record is invalid
3. If tampering confirmed, create new checkpoint and investigate

### "Production mode: initializing DurableAuditStreamStore" but then "InMemoryAuditStreamStore initialized"

**Problem**: Production falling back to in-memory (data loss risk)

**Solution**:
1. Check database connection is configured
2. Ensure TypeORM entities are registered
3. Run migrations: `npm run migrate`
4. Check logs for database errors

## Backward Compatibility

- ✅ No changes to existing AuditLog/AuditTrailService
- ✅ Additive feature (opt-in)
- ✅ Gradual migration possible
- ✅ No breaking API changes

## Related Documentation

- docs/AUDIT_STREAM_IMPLEMENTATION.md
- docs/AUDIT_STREAM_QUICK_REFERENCE.md
- docs/AUDIT_STREAM_OPERATIONS_RUNBOOK.md
