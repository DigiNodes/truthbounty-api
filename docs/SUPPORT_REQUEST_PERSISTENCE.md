# Support Request Persistence

**PREWAVE-BE-106 (#807)**: Durable support request storage with privacy-safe retention and encrypted contact details.

## Overview

Support requests are now persisted to PostgreSQL with field-level encryption, enabling:

- **Restart survival**: Requests survive API restarts and are visible across replicas
- **Duplicate detection**: Atomic duplicate suppression using keyed fingerprints
- **Quota enforcement**: Per-contact rate limiting enforced across instances
- **Privacy protection**: Contact and description fields encrypted at rest
- **Retention policy**: Automatic 30-day purge of expired records

## Architecture

### Database Schema

The `support_requests` table stores encrypted support data:

```sql
CREATE TABLE "support_requests" (
  "id" uuid PRIMARY KEY,
  "reference" varchar(32) UNIQUE,              -- Human-readable (SUP-ABC123)
  "category" varchar(32),                      -- bug, question, account, etc.
  "encryptedContact" text NOT NULL,            -- AES-256-GCM encrypted
  "encryptedDescription" text NOT NULL,        -- AES-256-GCM encrypted
  "release" varchar(120),                      -- Plaintext build identifier
  "diagnostics" jsonb DEFAULT '[]',            -- Safe diagnostic references
  "fingerprintKey" varchar(64) UNIQUE,         -- HMAC-SHA256 for duplicates
  "status" varchar(16) DEFAULT 'submitted',    -- submitted, duplicate, expired, deleted
  "duplicate" boolean DEFAULT false,
  "duplicateOf" uuid,
  "expiresAt" timestamptz NOT NULL,            -- Retention boundary
  "retentionDays" int DEFAULT 30,
  "createdAt" timestamptz DEFAULT now(),
  "updatedAt" timestamptz DEFAULT now()
);
```

### Encryption Model

**Field-level encryption** using AES-256-GCM:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: 256-bit key from `SUPPORT_ENCRYPTION_KEY` env var (64 hex chars)
- **IV**: Random 12-byte IV per encryption operation (stored with ciphertext)
- **Authentication**: 16-byte auth tag prevents tampering
- **Format**: `base64(IV || authTag || ciphertext)`

**Encrypted fields**:
- `encryptedContact`: Email, wallet handle, or user ID
- `encryptedDescription`: Support request content

**Plaintext fields** (non-sensitive):
- `category`, `release`, `diagnostics`, `status`, timestamps

**Fingerprint key** (non-reversible):
- HMAC-SHA256 keyed hash of normalized request fields
- Used for duplicate detection without storing plaintext
- Cannot be reversed to original contact/description

### Duplicate Detection

Duplicate suppression uses a **keyed fingerprint**:

1. Normalize request fields (lowercase contact, sorted diagnostics)
2. Compute `fingerprintKey = HMAC-SHA256(key, normalized_json)`
3. Check unique index on `fingerprintKey` (atomic via database constraint)
4. Reject duplicates within 24-hour window

**Race condition handling**:
- Unique constraint on `fingerprintKey` ensures atomic duplicate detection
- Concurrent submissions trigger `23505` unique violation
- Service catches violation and returns existing request reference

### Quota Enforcement

Per-contact quota (5 requests per 24 hours):

1. Query recent requests (created within last 24 hours)
2. Decrypt `encryptedContact` for each record
3. Count matching contacts
4. Reject if count >= 5

**Note**: Since contact is encrypted, quota checks require decryption. This is less efficient than plaintext indexing but preserves privacy.

### Retention Policy

**30-day retention** enforced by scheduled purge:

- **Cron job**: Runs daily at 2:00 AM (`SupportRetentionJob`)
- **Query**: `SELECT id FROM support_requests WHERE expiresAt <= NOW() AND status = 'submitted'`
- **Action**: `DELETE FROM support_requests WHERE id IN (...)`
- **Logging**: Purge count and references logged for operational visibility

**Manual trigger**:
```typescript
await supportRetentionJob.triggerManualPurge();
```

## Configuration

### Environment Variables

**Required**:
```bash
SUPPORT_ENCRYPTION_KEY=<64-hex-character-key>  # 32 bytes = 256 bits
```

Generate a secure key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Database** (inherited from `DatabaseModule`):
- Uses existing PostgreSQL connection from `DATABASE_URL` or `DB_*` variables
- No additional database configuration needed

### Key Rotation

Encryption keys cannot be rotated without re-encrypting existing records. To rotate:

1. Deploy new key as `SUPPORT_ENCRYPTION_KEY_NEW`
2. Run migration script to decrypt with old key, re-encrypt with new key
3. Update `SUPPORT_ENCRYPTION_KEY` to new value
4. Remove `SUPPORT_ENCRYPTION_KEY_NEW`

**Warning**: Key loss means permanent data loss. Back up keys securely.

## Operations

### Migration

Run the migration:
```bash
npm run migration:run
```

Verify migration:
```bash
npm run migration:status
```

Rollback (destructive):
```bash
npm run migration:revert
```

### Monitoring

**Metrics to track**:
- Support request creation rate
- Duplicate suppression rate
- Quota rejection rate
- Encryption/decryption errors
- Retention purge count

**Logs to monitor**:
- `Support request created: SUP-*` - Successful submission
- `Duplicate support request suppressed` - Duplicate detected
- `Support request quota exceeded` - Quota enforcement
- `Purged N expired support requests` - Retention purge
- `Failed to decrypt support request` - Encryption key issue

### Backup and Recovery

**Backup considerations**:
- Database backups include encrypted support requests
- Encryption key must be backed up separately (NOT in database)
- Restore requires both database backup AND encryption key

**Recovery procedure**:
1. Restore database from backup
2. Restore `SUPPORT_ENCRYPTION_KEY` to environment
3. Verify decryption works: `GET /support/requests/:id`

### Performance

**Expected load**:
- Low volume: < 100 requests/day typical
- Duplicate checks: O(1) via unique index
- Quota checks: O(N) where N = recent requests (< 50 typical)
- Retention purge: O(M) where M = expired records (< 1000 typical)

**Optimization**:
- Indexes on `fingerprintKey`, `expiresAt`, `createdAt` support efficient queries
- Quota checks decrypt only recent requests (24-hour window)
- Retention purge runs off-peak (2:00 AM)

## Security

### Access Control

**Public submission** (`POST /support/requests`):
- No authentication required
- Rate-limited by quota (5 per contact per 24h)
- Sensitive content filtered before storage

**Staff access** (`GET /support/requests`, `GET /support/requests/:id`, `DELETE /support/requests/:id`):
- Requires authentication (JWT)
- Requires role: `moderator` or `admin`
- Returns decrypted contact and description

**Enforcement**:
- `@Public()` decorator on submission endpoint
- `@Roles('moderator', 'admin')` on staff endpoints
- `assertSupportStaff()` in service layer

### Privacy Guarantees

1. **Encrypted at rest**: Contact and description encrypted in database
2. **Omitted from logs**: Encrypted fields never logged in plaintext
3. **Non-reversible fingerprints**: Duplicate detection uses keyed hash, not plaintext
4. **Time-bounded retention**: Automatic 30-day purge
5. **Staff-only access**: Public submitters cannot enumerate or fetch requests

### Threat Model

**Protected against**:
- ✅ Database breach (data encrypted at rest)
- ✅ Log leakage (sensitive fields omitted)
- ✅ Replay attacks (duplicate window + fingerprint)
- ✅ Enumeration (staff-only read access)
- ✅ Tampering (GCM authentication tag)

**Not protected against**:
- ❌ Encryption key compromise (rotating keys is complex)
- ❌ Application-level access (staff can decrypt all records)
- ❌ Side-channel timing attacks (constant-time comparison for auth tags)

## API Reference

### Submit Support Request

```http
POST /support/requests
Content-Type: application/json

{
  "category": "bug",
  "contact": "user@example.com",
  "description": "The app crashes when...",
  "release": "v1.2.3",
  "diagnostics": ["requestId: abc123"]
}
```

**Response** (201 Created):
```json
{
  "reference": "SUP-ABC123",
  "status": "submitted",
  "duplicate": false
}
```

**Response** (400 Bad Request - Duplicate):
```json
{
  "reference": "SUP-EXISTING",
  "status": "duplicate",
  "duplicate": true
}
```

**Response** (400 Bad Request - Quota):
```json
{
  "statusCode": 400,
  "message": "Support request quota exceeded. Please wait before submitting another request for this contact."
}
```

### List Support Requests (Staff Only)

```http
GET /support/requests
Authorization: Bearer <jwt-token>
```

**Response** (200 OK):
```json
[
  {
    "id": "uuid",
    "reference": "SUP-ABC123",
    "category": "bug",
    "contact": "user@example.com",
    "description": "The app crashes when...",
    "release": "v1.2.3",
    "diagnostics": ["requestId: abc123"],
    "status": "submitted",
    "duplicate": false,
    "duplicateOf": null,
    "createdAt": "2024-01-01T00:00:00Z",
    "expiresAt": "2024-01-31T00:00:00Z",
    "retentionDays": 30
  }
]
```

### Get Support Request (Staff Only)

```http
GET /support/requests/:id
Authorization: Bearer <jwt-token>
```

**Response** (200 OK): Same as list item

**Response** (404 Not Found): Request not found or expired

### Delete Support Request (Staff Only)

```http
DELETE /support/requests/:id
Authorization: Bearer <jwt-token>
```

**Response** (200 OK):
```json
{
  "deleted": true,
  "id": "uuid"
}
```

## Migration Guide

### From In-Memory to Persistent

**Before** (process-local Maps):
- Requests lost on restart
- Duplicates not detected across replicas
- Quota not enforced across replicas

**After** (PostgreSQL persistence):
- Requests survive restart
- Duplicates detected atomically via unique constraint
- Quota enforced across all API instances

**Breaking changes**:
- Service methods now return `Promise` (async)
- Controller methods updated to `async`
- Tests must use `await` for service calls

**Backward compatibility**:
- API endpoints unchanged (same routes, request/response format)
- Existing validation and filtering logic preserved
- Authorization model unchanged

## Testing

Run tests:
```bash
npm test src/support
```

**Test coverage**:
- ✅ Restart survival (persistence)
- ✅ Concurrent duplicate detection (race conditions)
- ✅ Encrypted field protection
- ✅ Retention purge behavior
- ✅ Authorization boundaries
- ✅ Quota enforcement
- ✅ Migration up/down
- ✅ Encryption/decryption round-trip
- ✅ Tamper detection (authentication tag)
- ✅ Fingerprint generation

## Troubleshooting

### Encryption Key Errors

**Error**: `SUPPORT_ENCRYPTION_KEY environment variable is required`

**Solution**: Set encryption key in environment:
```bash
export SUPPORT_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

**Error**: `SUPPORT_ENCRYPTION_KEY must be 64 hexadecimal characters`

**Solution**: Ensure key is exactly 64 hex characters (32 bytes):
```bash
echo $SUPPORT_ENCRYPTION_KEY | wc -c  # Should be 65 (64 + newline)
```

### Decryption Failures

**Error**: `Failed to decrypt support request data`

**Causes**:
1. Encryption key changed (data encrypted with different key)
2. Database corruption (ciphertext tampered)
3. Wrong key in environment

**Solution**:
1. Verify `SUPPORT_ENCRYPTION_KEY` matches key used during encryption
2. Check database integrity
3. If key lost, data cannot be recovered (restore from backup)

### Duplicate Detection Issues

**Symptom**: Duplicates not suppressed

**Checks**:
1. Verify unique index exists: `\d support_requests` in psql
2. Check fingerprint generation: Should be 64-char hex
3. Verify normalization (case, whitespace)

**Symptom**: False duplicates (different requests marked as duplicates)

**Cause**: Fingerprint collision (extremely rare with SHA-256)

**Solution**: Contact engineering team for investigation

### Quota Enforcement Issues

**Symptom**: Quota not enforced

**Checks**:
1. Verify recent requests query includes 24-hour window
2. Check contact decryption (encryption key correct)
3. Verify quota limit (default: 5 requests per 24h)

### Retention Purge Issues

**Symptom**: Expired requests not purged

**Checks**:
1. Verify cron job is running: Check logs for "Starting support request retention purge"
2. Check `expiresAt` timestamps: `SELECT expiresAt FROM support_requests WHERE status = 'submitted';`
3. Verify scheduled task module is imported in `AppModule`

**Manual trigger**:
```typescript
import { SupportRetentionJob } from './support/support-retention.job';

// In a controller or script
const purgedIds = await supportRetentionJob.triggerManualPurge();
console.log(`Purged ${purgedIds.length} records`);
```

## References

- Issue: #807 PREWAVE-BE-106
- Migration: `1793200000000-PersistSupportRequests.ts`
- Entity: `src/support/entities/support-request.entity.ts`
- Service: `src/support/support.service.ts`
- Encryption: `src/support/support-encryption.service.ts`
- Retention job: `src/support/support-retention.job.ts`
- Tests: `src/support/support-*.spec.ts`
