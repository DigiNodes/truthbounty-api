# Durable Audit Stream Implementation

This document describes the production audit stream store with hash-chained records, checkpoint management, and secure key rotation.

## Architecture

### Three-Layer Design

1. **Record Layer** (`AuditStreamStore`)
   - Abstract interface for appending records to tamper-evident streams
   - Enforces unique (streamId, sequence) constraints
   - Maintains hash-chain continuity (each record links to previous hash)
   - Serializable transactions prevent concurrent append conflicts

2. **Checkpoint Layer**
   - Periodic snapshots of stream state at specific sequence numbers
   - Captures head hash and active key ID for external verification
   - Enables recovery and consistency validation

3. **Key Management Layer** (`AuditKeyRegistry`)
   - Tracks HMAC key metadata without storing raw key material
   - Supports key rotation and revocation
   - Maintains historical keys for verifying old records
   - Raw keys loaded only from secure secret management (environment/vault)

### Implementations

#### DurableAuditStreamStore (Production)

Persists all records and checkpoints in the application database with:

- **Unique constraints**: `(streamId, sequence)` prevents duplicates across replicas
- **Atomic transactions**: Record append and checkpoint advance are transactional
- **Hash-chain verification**: Each record validates that `previousHash` matches the head
- **Index strategy**: 
  - `(streamId, sequence)` for fast lookups
  - `(streamId, createdAt)` for head queries
  - `(streamId)` for checkpoint uniqueness

#### InMemoryAuditStreamStore (Development/Testing)

In-memory maps with no persistence:

- **NOT for production**: Data lost on restart, cannot be shared across replicas
- **Test isolation**: Each test gets independent stream state
- **Fast iteration**: No database round-trips during development

The module enforces this boundary: production mode (NODE_ENV=production) **must** use DurableAuditStreamStore and fails startup otherwise.

## Hash-Chain Format

Each record is a link in an immutable chain:

```
Record 1: previousHash=0 → payloadHash=hash1 → hmacSignature=sig1(hash1)
Record 2: previousHash=hash1 → payloadHash=hash2 → hmacSignature=sig2(hash2)
Record 3: previousHash=hash2 → payloadHash=hash3 → hmacSignature=sig3(hash3)
```

**Payload Hashing**:
- Sanitize payload (remove secrets, passwords, tokens)
- Canonicalize: `JSON.stringify(sanitized, sortedKeys)`
- Hash: `SHA256(canonical)`

**Signing**:
- Create HMAC: `HMAC-SHA256(keyMaterial, payloadHash)`
- Sign only the hash to avoid storing or transmitting raw payload

**Verification**:
1. Recompute payload hash from record data
2. Look up key by keyId
3. Recompute HMAC with key material
4. Compare stored vs. recomputed HMAC
5. Validate chain: record.previousHash == priorRecord.payloadHash

## Key Management

### Active Key Requirements

Production startup requires:
1. `AUDIT_ACTIVE_KEY_ID` environment variable (e.g., `key-2024-01`)
2. `AUDIT_HMAC_KEY_<keyId>` secret available (e.g., `AUDIT_HMAC_KEY_key-2024-01`)

The registry loads the active key into memory on `onModuleInit()` and fails startup if either is missing.

### Key Rotation

```typescript
await keyRegistry.rotateKey('key-2024-02');
```

1. Deactivate old key (isActive=false)
2. Load new key material from secrets
3. Create metadata entry with isActive=true
4. Update in-memory activeKeyId
5. All new records use new key; old records retain their keyId for verification

### Key Revocation

```typescript
await keyRegistry.revokeKey('key-2024-01');
```

1. Set isActive=false and revokedAt=now()
2. Cannot revoke the active key (throws)
3. Historical records with revoked keys still verify (the key is in metadata)
4. Revoked keys are flagged during chain verification but don't invalidate other records

### Key Metadata Persistence

Only non-secret metadata is persisted:
- `keyId` (unique string identifier)
- `algorithm` (e.g., HMAC-SHA256)
- `createdAt` (timestamp)
- `revokedAt` (null until revoked)
- `isActive` (boolean)

**Raw key material is NEVER stored in application tables, logs, or exports.**

## Checkpoint Creation and Export

### Creating a Checkpoint

```typescript
const checkpoint = await auditStreamService.createCheckpoint('stream-1');
```

1. Fetch current head record
2. Capture its sequence, payloadHash, and keyId
3. Write checkpoint entry (atomic, transactional)
4. Can be used as a recovery point or proof-of-state at time T

### Exporting for External Verification

```typescript
const { checkpoint, records } = await auditStreamService.exportCheckpointForVerification('stream-1');
```

Returns:
- **checkpoint**: streamId, sequence, headHash, keyId, createdAt
- **records**: All records from sequence 1 to checkpoint sequence

External verifier can:
1. Reconstruct the hash chain offline
2. Download key material (using keyId as reference)
3. Verify HMAC signatures independently
4. Prove the stream was not tampered with

## Tamper Detection

Verification catches:

1. **Missing records**: Gaps in sequence numbers
2. **Hash mismatches**: previousHash doesn't link to prior record
3. **Sequence violations**: Out-of-order or duplicate sequences (database constraint)
4. **Unknown keys**: keyId not found in key metadata
5. **Revoked keys**: Flags for investigation (doesn't fail by default)
6. **Signature failures**: HMAC recompute doesn't match stored signature
7. **Checkpoint mismatch**: Stored checkpoint doesn't match stream state

## Configuration

### Environment Variables

```bash
# Active key (required for production)
AUDIT_ACTIVE_KEY_ID=key-2024-01

# Key material (must be in secrets/vault, not version control)
AUDIT_HMAC_KEY_key-2024-01=<64+ random hex chars>

# Optional rotation/revocation
# (Managed via service calls, not env vars)
```

### Database Schema

Three new tables:

```sql
audit_stream_records
  - streamId, sequence (unique together)
  - previousHash, payloadHash, hmacSignature, keyId
  - timestamp (ms since epoch for reproducible sorting)
  - createdAt (database timestamp)

audit_stream_checkpoints
  - streamId (unique)
  - sequence, headHash, keyId
  - createdAt

audit_key_metadata
  - keyId (unique)
  - algorithm, createdAt, revokedAt, isActive
```

Indexes optimized for:
- Head queries: `(streamId, createdAt DESC)`
- Sequence lookups: `(streamId, sequence)`
- Key lookups: `(isActive)` for active key discovery

## Recovery Scenarios

### Record Lost Before Checkpoint

If a record is deleted:
1. `verifyChain()` detects gap
2. Checkpoint has headHash; if checkpoint exists, can verify up to that point
3. If no checkpoint, return all errors (gap, missing record)

### Key Rotated Mid-Stream

Old records retain their keyId. During verification:
1. Load old key from metadata (may be revoked but still in registry)
2. Recompute HMAC with old key
3. Verify signature
4. Flag if key is revoked (for audit trail)

### Checkpoint Itself Corrupted

Checkpoints are immutable after creation. If corrupted:
1. Create new checkpoint at current head
2. Old checkpoint is ignored (verify against records directly)
3. Checkpoint is an optimization, not required for chain integrity

## Testing Strategy

Tests cover:

1. **Persistence**: Records and checkpoints survive restart
2. **Concurrency**: Parallel appends serialize safely via unique constraint
3. **Chain integrity**: Hash-chain verification detects tampering
4. **Key rotation**: Old records verify after key rotation
5. **Recovery**: Missing key yields closed-loop failure, not cascading failures
6. **Gaps and mismatches**: Tampered payloads, deleted records, sequence gaps detected
7. **Production boundaries**: In-memory store fails at startup in production mode

## Security Considerations

1. **Payload sanitization**: Secrets not included in hash/signature
2. **Canonical serialization**: Sort keys to ensure reproducible hashes
3. **Timing-safe comparison**: Use crypto.timingSafeEqual for signatures
4. **Key isolation**: Raw keys never logged, exported, or stored durably
5. **Transactional safety**: Append and checkpoint advance are atomic
6. **Replica consistency**: Unique constraints prevent split-brain
7. **Key rotation without downtime**: Old keys remain verifiable
8. **Audit trail**: Key rotation and revocation are logged separately

## Backward Compatibility

This implementation is **additive**:
- Existing AuditLog/AuditTrailService unchanged
- AuditStreamService is a parallel, opt-in feature
- No breaking changes to API or database schemas
- Gradual migration: new logs can use stream service while old logs remain in AuditLog

## Maintenance

### Monitoring

Watch for:
- Verification errors during chain validation
- Failed key lookups (keyId not in metadata)
- Unusual key rotation frequency
- Checkpoint creation latency (indicates transaction bottleneck)

### Key Retirement

After rotation, old keys can be retired:
1. Ensure all records signed with old key are archived (if applicable)
2. Update revokedAt in metadata
3. After retention period, key metadata can be purged (keep for compliance)

### Database Growth

Stream records grow linearly:
- Each record: ~400 bytes (IDs, hashes, timestamps, indexes)
- Checkpoints: ~300 bytes (sparse, one per stream)
- Key metadata: ~200 bytes (slow growth, one per rotation)

Prune old checkpoints after they're no longer needed for recovery.
