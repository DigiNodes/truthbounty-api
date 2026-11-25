/**
 * Security and Administrative Audit Stream Chaining Types.
 * Production-readiness boundary for canonical serialization and per-stream hash chaining.
 */

export interface AuditStreamBinding {
  /** Authoritative chain ID (e.g. 10 for Optimism, 11155420 for OP Sepolia). */
  chainId: number;
  /** UUID of the deployed software release. */
  releaseId: string;
  /** Canonical deployment block number as string to prevent integer overflow. */
  deploymentBlock: string;
  /** Authoritative 0x-prefixed 32-byte hex checksum of release artifacts. */
  artifactChecksum: string;
}

export type AuditRecordType = 'security' | 'administrative' | 'operational';
export type AuditActorType = 'user' | 'service' | 'system';
export type AuditAuthoritySource = 'rbac' | 'policy' | 'service' | 'chain';

export interface AuditStreamRecordPayload {
  eventId: string;
  recordType: AuditRecordType;
  action: string;
  actorId: string;
  actorType: AuditActorType;
  targetType: string;
  targetId: string;
  capability: string;
  authoritySource: AuditAuthoritySource;
  authorityReference: string;
  requestReference: string;
  correlationId: string;
  outcome: string;
  severity?: string;
  resultReference?: string | null;
  chainContext: AuditStreamBinding;
}

export interface AuditStreamRecord extends AuditStreamRecordPayload {
  streamId: string;
  /** 1-based, strictly monotonically increasing sequence number within the stream. */
  sequence: number;
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  /** Key ID used to generate integrityHash (supports key rotation). */
  keyId: string;
  /** Hash of the prior record in this stream, or Genesis Hash if sequence === 1. */
  previousHash: string;
  /** Canonical HMAC-SHA256 integrity hash of this record. */
  integrityHash: string;
}

export interface AuditStreamCheckpoint {
  streamId: string;
  sequence: number;
  headHash: string;
  timestamp: string;
  chainContext: AuditStreamBinding;
  keyId: string;
  checkpointHash: string;
}


export interface AuditAppendResult {
  streamId: string;
  sequence: number;
  hash: string;
}

export interface AuditStreamAppendResult extends AuditAppendResult {}


export interface AuditVerificationOptions {
  fromSequence?: number;
  toSequence?: number;
  expectedBinding?: AuditStreamBinding;
  checkpoint?: AuditStreamCheckpoint;
}

export interface AuditVerificationReport {
  valid: boolean;
  streamId: string;
  recordsChecked: number;
  fromSequence: number;
  toSequence: number;
  headHash: string | null;
  firstInvalid?: {
    sequence: number;
    eventId?: string;
    reason: string;
    details?: Record<string, unknown>;
  };
  errors: string[];
  warnings: string[];
  verifiedAt: string;
  disclaimer: string;
}

export enum AuditCorruptionType {
  MUTATION = 'MUTATION',
  DELETION_GAP = 'DELETION_GAP',
  DUPLICATE_SEQUENCE = 'DUPLICATE_SEQUENCE',
  REORDER = 'REORDER',
  INSERTION = 'INSERTION',
  PREVIOUS_HASH_MISMATCH = 'PREVIOUS_HASH_MISMATCH',
  HASH_TAMPER = 'HASH_TAMPER',
  KEY_UNKNOWN = 'KEY_UNKNOWN',
  BINDING_MISMATCH = 'BINDING_MISMATCH',
  CHECKPOINT_MISMATCH = 'CHECKPOINT_MISMATCH',
  INVALID_SEQUENCE = 'INVALID_SEQUENCE',
}

export interface CorruptionFinding {
  sequence: number;
  eventId?: string;
  corruptionType: AuditCorruptionType;
  description: string;
  expected?: string | number | Record<string, unknown>;
  actual?: string | number | Record<string, unknown>;
}

export interface AuditCorruptionReport {
  streamId: string;
  status: 'HEALTHY' | 'CORRUPTED';
  detectedAt: string;
  recordsAnalyzed: number;
  corruptionsFound: CorruptionFinding[];
  summary: string;
  disclaimer: string;
}

export interface AuditStreamExport {
  format: 'truthbounty-audit-stream-export-v1';
  streamId: string;
  exportedAt: string;
  chainContext: AuditStreamBinding;
  recordCount: number;
  fromSequence: number;
  toSequence: number;
  headHash: string;
  checkpoints: AuditStreamCheckpoint[];
  records: AuditStreamRecord[];
  disclaimer: string;
}

export const AUDIT_STREAM_DISCLAIMER =
  'Hash-chaining guarantees tamper-evidence and detectability of unauthorized mutations ' +
  'within an append-only audit stream; it does NOT claim decentralized blockchain consensus immutability.';


const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_.:-]{0,95}$/i;
const BLOCK_RE = /^(0|[1-9][0-9]{0,19})$/;
const CHECKSUM_RE = /^0x[0-9a-fA-F]{64}$/;

export function validateAuditStreamBinding(
  binding: unknown,
): AuditStreamBinding {
  if (!binding || typeof binding !== 'object') {
    throw new Error('Audit stream binding is required');
  }

  const b = binding as Partial<AuditStreamBinding>;

  if (!Number.isSafeInteger(b.chainId) || (b.chainId as number) <= 0) {
    throw new Error(`Invalid audit chainId: ${b.chainId}`);
  }


  if (!b.releaseId || !UUID_RE.test(b.releaseId)) {
    throw new Error(`Invalid audit releaseId: ${b.releaseId}`);
  }

  if (!b.deploymentBlock || !BLOCK_RE.test(b.deploymentBlock)) {
    throw new Error(`Invalid audit deploymentBlock: ${b.deploymentBlock}`);
  }


  if (!b.releaseId || !UUID_RE.test(b.releaseId)) {
    throw new Error(`Invalid audit releaseId: ${b.releaseId}`);
  }
  if (!b.deploymentBlock || !BLOCK_RE.test(b.deploymentBlock)) {
    throw new Error(`Invalid audit deploymentBlock: ${b.deploymentBlock}`);
  }

  if (!b.artifactChecksum || !CHECKSUM_RE.test(b.artifactChecksum)) {
    throw new Error(`Invalid audit artifactChecksum: ${b.artifactChecksum}`);
  }

  return {
    chainId: b.chainId as number,
    releaseId: b.releaseId.toLowerCase(),
    deploymentBlock: b.deploymentBlock,
    artifactChecksum: b.artifactChecksum.toLowerCase(),
  };
}

export function validateRecordPayload(
  payload: AuditStreamRecordPayload,
): AuditStreamRecordPayload {
  for (const [key, value] of [
    ['eventId', payload.eventId],
    ['actorId', payload.actorId],
    ['targetId', payload.targetId],
    ['authorityReference', payload.authorityReference],
    ['requestReference', payload.requestReference],
    ['correlationId', payload.correlationId],
  ] as const) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new Error(`Audit record ${key} must be a valid UUID`);
    }
  }

  if (
    payload.resultReference !== undefined &&
    payload.resultReference !== null &&
    !UUID_RE.test(payload.resultReference)
  ) {
    throw new Error('Audit record resultReference must be a UUID when present');
  }

  if (
    typeof payload.capability !== 'string' ||
    !CODE_RE.test(payload.capability) ||
    typeof payload.targetType !== 'string' ||
    !CODE_RE.test(payload.targetType) ||
    typeof payload.action !== 'string' ||
    !CODE_RE.test(payload.action)
  ) {
    throw new Error('Audit capability, targetType, and action must be valid codes');
  }

  if (!['security', 'administrative', 'operational'].includes(payload.recordType)) {
    throw new Error(`Invalid audit recordType: ${payload.recordType}`);
  }

  if (!['user', 'service', 'system'].includes(payload.actorType)) {
    throw new Error(`Invalid audit actorType: ${payload.actorType}`);
  }

  if (!['rbac', 'policy', 'service', 'chain'].includes(payload.authoritySource)) {
    throw new Error(`Invalid audit authoritySource: ${payload.authoritySource}`);
  }

  const validBinding = validateAuditStreamBinding(payload.chainContext);

  return {
    ...payload,
    resultReference: payload.resultReference ?? null,
    chainContext: validBinding,
  };
}


// Legacy type compatibility
export interface AuditStreamVerifyResult {
  valid: boolean;
  reason?: string;
  details?: {
    recordFound: boolean;
    sequenceValid: boolean;
    hashValid: boolean;
    signatureValid: boolean;
    keyAvailable: boolean;
  };
}

export interface AuditStreamKey {
  keyId: string;
  algorithm: string;
  createdAt: Date;
  revokedAt?: Date;
  isActive: boolean;
}
