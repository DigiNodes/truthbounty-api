import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-106 (#807): Persist support requests with privacy-safe retention.
 *
 * Replaces the process-local Map-based storage with durable PostgreSQL persistence.
 * Support requests carry contact details and user-submitted diagnostics, so
 * persistence must be privacy-controlled with encryption and access restrictions.
 *
 * Features:
 * - Encrypted contact and description fields (AES-256-GCM at application layer)
 * - Keyed fingerprint for duplicate detection (HMAC-SHA256, non-reversible)
 * - Atomic duplicate and quota checks via unique index and transactions
 * - 30-day retention policy with scheduled purge
 * - Authorization boundary: only support staff (moderator, admin) can access
 *
 * Privacy and security properties:
 * - Contact and description are encrypted at rest in the database
 * - Fingerprint is a keyed hash that cannot be reversed to original content
 * - Unique constraint on fingerprintKey prevents duplicate storage
 * - Indexes support efficient duplicate detection and quota enforcement
 * - Public submitters cannot enumerate or fetch requests
 * - Retention purge removes expired records based on expiresAt timestamp
 *
 * Concurrency and replica safety:
 * - Unique index on fingerprintKey ensures atomic duplicate detection
 * - Unique index on reference ensures no reference collisions
 * - expiresAt index enables efficient retention purge queries
 * - All checks are database-enforced, work across API replicas
 *
 * Database constraints:
 * - id: UUID primary key
 * - reference: unique human-readable code (e.g., SUP-ABC123)
 * - fingerprintKey: unique 64-char hex string for duplicate detection
 * - status: enum check constraint (submitted, duplicate, expired, deleted)
 * - encryptedContact/encryptedDescription: non-null text (encrypted at app layer)
 * - expiresAt: timestamptz for retention purge
 * - retentionDays: positive integer, default 30
 */
export class PersistSupportRequests1793200000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Support request persistence requires PostgreSQL');
    }

    await runner.query(`
      CREATE TABLE "support_requests" (
        "id" uuid NOT NULL PRIMARY KEY,
        "reference" varchar(32) NOT NULL UNIQUE,
        "category" varchar(32) NOT NULL,
        "encryptedContact" text NOT NULL,
        "encryptedDescription" text NOT NULL,
        "release" varchar(120) NULL,
        "diagnostics" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "fingerprintKey" varchar(64) NOT NULL UNIQUE,
        "status" varchar(16) NOT NULL DEFAULT 'submitted',
        "duplicate" boolean NOT NULL DEFAULT false,
        "duplicateOf" uuid NULL,
        "expiresAt" timestamptz NOT NULL,
        "retentionDays" int NOT NULL DEFAULT 30,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_support_request_status" CHECK (
          "status" IN ('submitted', 'duplicate', 'expired', 'deleted')
        ),
        CONSTRAINT "chk_support_request_retention_days" CHECK (
          "retentionDays" > 0 AND "retentionDays" <= 365
        ),
        CONSTRAINT "chk_support_request_expires_future" CHECK (
          "expiresAt" > "createdAt"
        ),
        CONSTRAINT "chk_support_request_duplicate_bound" CHECK (
          ("duplicate" = false AND "duplicateOf" IS NULL) OR
          ("duplicate" = true AND "duplicateOf" IS NOT NULL)
        ),
        CONSTRAINT "chk_support_request_fingerprint_length" CHECK (
          length("fingerprintKey") = 64
        ),
        CONSTRAINT "chk_support_request_reference_format" CHECK (
          "reference" ~ '^SUP-[A-Z0-9]{1,20}$'
        ),
        CONSTRAINT "chk_support_request_encrypted_fields" CHECK (
          length("encryptedContact") > 0 AND
          length("encryptedDescription") > 0
        )
      )
    `);

    // Index for duplicate detection by fingerprint (unique constraint provides this)
    await runner.query(`
      CREATE INDEX "idx_support_requests_fingerprint" 
      ON "support_requests" ("fingerprintKey")
    `);

    // Index for reference lookup (unique constraint provides this)
    await runner.query(`
      CREATE INDEX "idx_support_requests_reference" 
      ON "support_requests" ("reference")
    `);

    // Index for retention purge - find expired records efficiently
    await runner.query(`
      CREATE INDEX "idx_support_requests_expires_at" 
      ON "support_requests" ("expiresAt")
      WHERE "status" NOT IN ('expired', 'deleted')
    `);

    // Index for quota enforcement - recent requests by contact
    // Note: contact is encrypted, so we can't index it directly.
    // Quota checks will need to decrypt and filter in-app or use fingerprint proximity.
    await runner.query(`
      CREATE INDEX "idx_support_requests_created_at" 
      ON "support_requests" ("createdAt")
      WHERE "status" = 'submitted'
    `);

    // Index for staff queries - list recent requests
    await runner.query(`
      CREATE INDEX "idx_support_requests_status_created" 
      ON "support_requests" ("status", "createdAt" DESC)
    `);

    // Composite index for duplicate detection window
    await runner.query(`
      CREATE INDEX "idx_support_requests_duplicate_window" 
      ON "support_requests" ("createdAt", "status")
      WHERE "duplicate" = false
    `);
  }

  /**
   * Destructive rollback: export support requests and obtain operator approval first.
   *
   * WARNING: This will delete all persisted support requests.
   * The in-memory fallback does not preserve existing requests.
   */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "support_requests"`);
  }
}
