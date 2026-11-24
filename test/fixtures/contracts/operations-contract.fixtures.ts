/**
 * UX-BE-004 (#595) — Protected Operations, Safe-Retry and Audit Fixtures
 *
 * Deterministic, sanitized fixtures for every protected operations state the
 * privileged boards render. No secrets, credentials, raw authorization
 * headers, protected evidence, or internal topology appear here.
 */

export const OPERATIONS_OPENAPI_VERSION = '1.0.0';

export const CANONICAL_OPERATIONS_CAPABILITIES = [
  'OPERATIONS_QUEUE_READ',
  'OPERATIONS_RETRY_READ',
  'OPERATIONS_RETRY_SUBMIT',
  'OPERATIONS_AUDIT_READ',
] as const;

export const CANONICAL_AUTHORITY_SOURCES = [
  'PROTOCOL_OPERATOR',
  'EMERGENCY_ADMIN',
  'SYSTEM',
] as const;

export const CANONICAL_QUEUE_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'quarantined',
] as const;

export const CANONICAL_IMPACTS = ['low', 'medium', 'high'] as const;

export const CANONICAL_DUPLICATION_RISKS = [
  'idempotent',
  'idempotent_replay',
  'possible',
] as const;

export const CANONICAL_FRESHNESS_STATES = [
  'fresh',
  'stale',
  'unknown',
] as const;

export const CANONICAL_OPERATIONS_ERROR_CODES = [
  'DENIED',
  'STALE_AUTHORITY',
  'CONFLICT',
  'ALREADY_COMPLETED',
  'UNSAFE_TO_RETRY',
  'NOT_RETRYABLE',
  'UNAVAILABLE',
  'RATE_LIMITED',
] as const;

export interface OperationalQueueItemFixture {
  id: string;
  releaseId: string;
  capability: (typeof CANONICAL_OPERATIONS_CAPABILITIES)[number];
  authoritySource: (typeof CANONICAL_AUTHORITY_SOURCES)[number];
  authorityExpiresAt: string | null;
  status: (typeof CANONICAL_QUEUE_STATUSES)[number];
  impact: (typeof CANONICAL_IMPACTS)[number];
  duplicationRisk: (typeof CANONICAL_DUPLICATION_RISKS)[number];
  freshness: (typeof CANONICAL_FRESHNESS_STATES)[number];
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  version: string;
  updatedAt: string;
  summary: string;
}

export interface CanonicalOperationsErrorFixture {
  statusCode: number;
  errorCode: (typeof CANONICAL_OPERATIONS_ERROR_CODES)[number];
  message: string;
  auditId: string;
  timestamp: string;
}

export const OPERATIONS_FIXTURES = {
  release: {
    releaseVersion: 'v2.0.0-sepolia',
    protocolVersion: '2.0.0',
    chainId: 11155420,
    openapiVersion: OPERATIONS_OPENAPI_VERSION,
  },

  itemDetail: {
    id: 'queue-001',
    releaseId: 'v2.0.0-sepolia',
    capability: 'OPERATIONS_RETRY_SUBMIT',
    authoritySource: 'PROTOCOL_OPERATOR',
    authorityExpiresAt: '2026-10-22T00:00:00.000Z',
    status: 'failed',
    impact: 'medium',
    duplicationRisk: 'idempotent_replay',
    freshness: 'fresh',
    attempts: 1,
    maxAttempts: 5,
    retryable: true,
    version: '100',
    updatedAt: '2026-10-16T00:00:00.000Z',
    summary: 'outbox event: notification.send',
  } satisfies OperationalQueueItemFixture,

  queueSummary: {
    releaseId: 'v2.0.0-sepolia',
    generatedAt: '2026-10-16T00:00:00.000Z',
    total: 1,
    countsByStatus: {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 1,
      quarantined: 0,
    },
    items: [
      {
        id: 'queue-001',
        releaseId: 'v2.0.0-sepolia',
        capability: 'OPERATIONS_RETRY_SUBMIT',
        authoritySource: 'PROTOCOL_OPERATOR',
        authorityExpiresAt: '2026-10-22T00:00:00.000Z',
        status: 'failed',
        impact: 'medium',
        duplicationRisk: 'idempotent_replay',
        freshness: 'fresh',
        attempts: 1,
        maxAttempts: 5,
        retryable: true,
        version: '100',
        updatedAt: '2026-10-16T00:00:00.000Z',
        summary: 'outbox event: notification.send',
      } satisfies OperationalQueueItemFixture,
    ],
  },

  retryEligibility: {
    id: 'queue-001',
    eligible: true,
    reason: null,
    attemptsRemaining: 4,
    preconditionToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },

  retrySubmission: {
    id: 'queue-001',
    accepted: true,
    auditId: '11111111-1111-4111-8111-111111111111',
    replayed: 1,
    skipped: 0,
    failed: 0,
    detail: null,
  },

  auditRecord: {
    auditId: '11111111-1111-4111-8111-111111111111',
    action: 'queue.retry',
    capability: 'OPERATIONS_RETRY_SUBMIT',
    authoritySource: 'PROTOCOL_OPERATOR',
    actorId: 'admin-1',
    outcome: 'accepted',
    resultCode: 'ACCEPTED',
    subjectId: 'queue-001',
    createdAt: '2026-10-16T00:00:00.000Z',
  },
} as const;

const FAIL_CLOSED_BASE = {
  timestamp: '2026-10-16T00:00:00.000Z',
  auditId: '22222222-2222-4222-8222-222222222222',
};

/** One sanitized fixture per canonical fail-closed response. */
export const OPERATIONS_FAIL_CLOSED_FIXTURES = {
  denied: {
    ...FAIL_CLOSED_BASE,
    statusCode: 403,
    errorCode: 'DENIED',
    message: 'Caller authority does not grant the required capability.',
  },
  staleAuthority: {
    ...FAIL_CLOSED_BASE,
    statusCode: 403,
    errorCode: 'STALE_AUTHORITY',
    message: 'Caller authority is expired or ambiguous.',
  },
  conflict: {
    ...FAIL_CLOSED_BASE,
    statusCode: 409,
    errorCode: 'CONFLICT',
    message: 'The request conflicts with the current state of the item.',
  },
  alreadyCompleted: {
    ...FAIL_CLOSED_BASE,
    statusCode: 409,
    errorCode: 'ALREADY_COMPLETED',
    message: 'The operation is already completed and cannot be retried.',
  },
  unsafeToRetry: {
    ...FAIL_CLOSED_BASE,
    statusCode: 409,
    errorCode: 'UNSAFE_TO_RETRY',
    message: 'Retrying this item would risk duplicating an existing effect.',
  },
  unavailable: {
    ...FAIL_CLOSED_BASE,
    statusCode: 503,
    errorCode: 'UNAVAILABLE',
    message: 'A required dependency is temporarily unavailable; retry later.',
  },
  rateLimited: {
    ...FAIL_CLOSED_BASE,
    statusCode: 429,
    errorCode: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  },
} satisfies Record<string, CanonicalOperationsErrorFixture>;
