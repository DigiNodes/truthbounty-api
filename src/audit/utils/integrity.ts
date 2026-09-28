import * as crypto from 'crypto';

export interface AuditHashableRecord {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  userId?: string | null;
  walletAddress?: string | null;
  description?: string | null;
  beforeState?: Record<string, any> | null;
  afterState?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  createdAt: Date | string;
  previousHash?: string | null;
  chainSequence?: number | null;
}

/**
 * Computes a keyed (HMAC-SHA256) integrity hash for an audit record.
 *
 * A keyed hash is required, not a plain digest: with plain SHA-256, anyone
 * with write access to the `audit_logs` table (a compromised app process,
 * a rogue migration, direct DB access) can edit a row and recompute a
 * "valid" hash for it, since the hash function and all its inputs are
 * public. HMAC with a secret that is never stored in the database closes
 * that gap: recomputing a valid hash requires the secret, not just DB
 * access.
 *
 * `previousHash` and `chainSequence` are included in the hashed payload so
 * that altering, reordering, or deleting a record breaks the hash of
 * every record chained after it, not just the record itself. See
 * `verifyChain` in `AuditTrailService` for how the chain as a whole is
 * verified.
 *
 * @param secret - HMAC key, from `AUDIT_HASH_SECRET`. Never derived from
 *   or stored alongside the data it protects.
 */
export function computeAuditRecordHash(
  record: AuditHashableRecord,
  secret: string,
): string {
  const normalized = {
    id: record.id,
    actionType: record.actionType,
    entityType: record.entityType,
    entityId: record.entityId,
    userId: record.userId ?? null,
    walletAddress: record.walletAddress ?? null,
    description: record.description ?? null,
    beforeState: record.beforeState ?? null,
    afterState: record.afterState ?? null,
    metadata: record.metadata ?? null,
    ipAddress: record.ipAddress ?? null,
    userAgent: record.userAgent ?? null,
    correlationId: record.correlationId ?? null,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : record.createdAt,
    previousHash: record.previousHash ?? null,
    chainSequence: record.chainSequence ?? null,
  };

  const serialized = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHmac('sha256', secret).update(serialized).digest('hex');
}

/**
 * Verifies a single record's own hash. This only proves the record's
 * content has not changed since it was hashed. It cannot detect a whole
 * record being deleted, or the chain being reordered. Use
 * `AuditTrailService.verifyChain` for that.
 */
export function verifyAuditRecordHash(
  record: AuditHashableRecord & { integrityHash?: string | null },
  secret: string,
): boolean {
  if (!record.integrityHash) {
    return false;
  }
  const { integrityHash, ...rest } = record;
  const expectedHash = computeAuditRecordHash(rest, secret);
  return expectedHash === integrityHash;
}

// Backward-compatible aliases for the pre-chain plain-SHA256 API. Kept so
// this change stays the smallest cohesive diff; callers should prefer the
// names above, which make the HMAC secret requirement explicit.
// TODO(V2-BE-110 follow-up): remove once all call sites are migrated.
export const generateAuditHash = computeAuditRecordHash;
export const verifyAuditIntegrity = verifyAuditRecordHash;
