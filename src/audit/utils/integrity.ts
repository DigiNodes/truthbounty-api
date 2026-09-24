import * as crypto from 'crypto';

export function generateAuditHash(record: {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  userId?: string;
  walletAddress?: string;
  description?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  createdAt: Date | string;
  previousHash?: string;
}): string {
  const normalized = {
    id: record.id,
    actionType: record.actionType,
    entityType: record.entityType,
    entityId: record.entityId,
    userId: record.userId || null,
    walletAddress: record.walletAddress || null,
    description: record.description || null,
    beforeState: record.beforeState || null,
    afterState: record.afterState || null,
    metadata: record.metadata || null,
    ipAddress: record.ipAddress || null,
    userAgent: record.userAgent || null,
    correlationId: record.correlationId || null,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    previousHash: record.previousHash || null,
  };

  const serialized = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export function verifyAuditIntegrity(
  record: { integrityHash?: string; [key: string]: any },
): boolean {
  if (!record.integrityHash) {
    return false;
  }
  const { integrityHash: _, ...rest } = record;
  const expectedHash = generateAuditHash(rest as any);
  return expectedHash === record.integrityHash;
}
