-- CreateTable: operations_idempotency_keys
-- Durable idempotency key records for operational retry requests.
-- Replaces the process-local Map in OperationsService.
CREATE TABLE "operations_idempotency_keys" (
    "key" VARCHAR(256) NOT NULL PRIMARY KEY,
    "itemId" VARCHAR(128) NOT NULL,
    "actorId" UUID,
    "capability" VARCHAR(128) NOT NULL,
    "authoritySource" VARCHAR(64) NOT NULL,
    "authorityExpiresAt" TIMESTAMPTZ,
    "outcome" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    
    -- Check constraints
    CONSTRAINT "chk_ops_idem_expires_after_created" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "chk_ops_idem_capability_valid" CHECK ("capability" IN (
        'OPERATIONS_QUEUE_READ',
        'OPERATIONS_RETRY_READ',
        'OPERATIONS_RETRY_SUBMIT',
        'OPERATIONS_AUDIT_READ'
    )),
    CONSTRAINT "chk_ops_idem_authority_valid" CHECK ("authoritySource" IN (
        'SYSTEM',
        'PROTOCOL_OPERATOR',
        'EMERGENCY_ADMIN'
    ))
);

-- CreateTable: operations_audit_logs
-- Durable, immutable audit records for operational retry requests.
-- Replaces the bounded in-memory Map in InMemoryOperationsAuditStore.
CREATE TABLE "operations_audit_logs" (
    "auditId" UUID NOT NULL PRIMARY KEY,
    "action" VARCHAR(128) NOT NULL,
    "capability" VARCHAR(128) NOT NULL,
    "authoritySource" VARCHAR(64) NOT NULL,
    "actorId" UUID,
    "outcome" VARCHAR(16) NOT NULL,
    "resultCode" VARCHAR(64) NOT NULL,
    "subjectId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retentionUntil" TIMESTAMPTZ NOT NULL,
    
    -- Check constraints
    CONSTRAINT "chk_ops_audit_outcome_valid" CHECK ("outcome" IN ('accepted', 'rejected')),
    CONSTRAINT "chk_ops_audit_capability_valid" CHECK ("capability" IN (
        'OPERATIONS_QUEUE_READ',
        'OPERATIONS_RETRY_READ',
        'OPERATIONS_RETRY_SUBMIT',
        'OPERATIONS_AUDIT_READ'
    )),
    CONSTRAINT "chk_ops_audit_authority_valid" CHECK ("authoritySource" IN (
        'SYSTEM',
        'PROTOCOL_OPERATOR',
        'EMERGENCY_ADMIN'
    )),
    CONSTRAINT "chk_ops_audit_retention_after_created" CHECK ("retentionUntil" >= "createdAt")
);

-- Indexes for operations_idempotency_keys
CREATE INDEX "idx_ops_idem_expires" ON "operations_idempotency_keys"("expiresAt");
CREATE INDEX "idx_ops_idem_item" ON "operations_idempotency_keys"("itemId");
CREATE INDEX "idx_ops_idem_actor_created" ON "operations_idempotency_keys"("actorId", "createdAt");

-- Indexes for operations_audit_logs
CREATE INDEX "idx_ops_audit_actor_time" ON "operations_audit_logs"("actorId", "createdAt");
CREATE INDEX "idx_ops_audit_subject" ON "operations_audit_logs"("subjectId");
CREATE INDEX "idx_ops_audit_outcome_time" ON "operations_audit_logs"("outcome", "createdAt");
CREATE INDEX "idx_ops_audit_retention" ON "operations_audit_logs"("retentionUntil");

-- Comments for documentation
COMMENT ON TABLE "operations_idempotency_keys" IS 'Durable idempotency keys for operational retry requests. Prevents duplicate retry execution across API replicas and restarts. Keys expire after TTL and are cleaned up periodically.';
COMMENT ON TABLE "operations_audit_logs" IS 'Immutable audit trail for operational retry requests. Records survive restarts and provide forensic evidence for security review and compliance. Never updated or deleted except by retention policy.';

COMMENT ON COLUMN "operations_idempotency_keys"."key" IS 'Caller-supplied idempotency key (UUID or hash). Primary key.';
COMMENT ON COLUMN "operations_idempotency_keys"."itemId" IS 'Queue item ID this key was used to retry. Checked on duplicate key submission.';
COMMENT ON COLUMN "operations_idempotency_keys"."outcome" IS 'Canonical retry submission outcome, replayed for duplicate keys. JSON: {id, accepted, auditId, replayed, skipped, failed, detail}';
COMMENT ON COLUMN "operations_idempotency_keys"."expiresAt" IS 'When this key becomes eligible for cleanup. Set to createdAt + TTL (default: 24 hours).';

COMMENT ON COLUMN "operations_audit_logs"."auditId" IS 'Unique audit identifier returned in retry responses and error messages.';
COMMENT ON COLUMN "operations_audit_logs"."action" IS 'Action being audited, e.g., "queue.retry". Machine-readable, stable across releases.';
COMMENT ON COLUMN "operations_audit_logs"."retentionUntil" IS 'When this record becomes eligible for archival or deletion. Default: createdAt + 90 days.';
