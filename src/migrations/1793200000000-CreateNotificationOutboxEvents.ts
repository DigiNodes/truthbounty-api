import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-019 / #615 — Create `notification_outbox_events` table.
 *
 * ## Purpose
 *
 * This table is the canonical durable record for the notification Transactional
 * Outbox, used by:
 *   - NotificationEventPublisher (write side)
 *   - OutboxScheduler (polling / dispatch side)
 *   - NotificationProcessor (claim / complete / fail side)
 *   - NotificationMetricsService (observability)
 *
 * It is distinct from the V2 `v2_outbox_messages` table
 * (migration 1790300000000-CreateV2OutboxMessages.ts), which serves the
 * TypeORM-native V2 outbox for chain-derived events.  This table serves the
 * notification delivery pipeline.
 *
 * ## At-least-once delivery
 *
 * A caller writes a row **inside the same EntityManager transaction** as its
 * domain state change.  The poller claims PENDING rows via
 * `FOR UPDATE SKIP LOCKED`, dispatches them to BullMQ (using idempotencyKey
 * as the jobId prefix), and marks them DISPATCHED.  Concurrent workers cannot
 * double-complete a row because the lock is held for the duration of the
 * claim-and-dispatch sequence.
 *
 * ## Idempotency
 *
 * The UNIQUE constraint on `idempotencyKey` prevents duplicate rows for the
 * same logical event at the database layer, before any application code runs
 * (fail-closed).  BullMQ independently deduplicates at the queue layer via
 * the same key.
 *
 * ## Retry history
 *
 * `retryCount` increments on each failed attempt; `lastError` stores the most
 * recent failure message (truncated to 1000 chars — full stack traces must not
 * be stored here to prevent PII/secret leakage).  The CHECK constraint
 * `chk_notification_outbox_retry_lte_max` enforces the invariant that
 * `retryCount` can never exceed `maxRetries` at the database level.
 *
 * ## Migration safety
 *
 * - The `down()` method drops only the objects created by `up()`.
 * - The shared trigger function `set_outbox_updated_at` is created idempotently
 *   and is NOT dropped on rollback because other tables may share it.
 * - In production: drain the queue before rolling back to avoid losing
 *   PENDING / PROCESSING rows.
 */
export class CreateNotificationOutboxEvents1793200000000
  implements MigrationInterface
{
  name = 'CreateNotificationOutboxEvents1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Main table ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notification_outbox_events" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "eventType"           varchar(128) NOT NULL,
        "aggregateId"         varchar(128) NOT NULL,
        "payload"             json         NOT NULL DEFAULT '{}',
        "idempotencyKey"      varchar(64)  NOT NULL,
        "status"              varchar(16)  NOT NULL DEFAULT 'PENDING',
        "retryCount"          integer      NOT NULL DEFAULT 0,
        "maxRetries"          integer      NOT NULL DEFAULT 5,
        "lastError"           text                  DEFAULT NULL,
        "jobId"               varchar(256)          DEFAULT NULL,
        "scheduledAt"         timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processingDeadline"  timestamptz           DEFAULT NULL,
        "processedAt"         timestamptz           DEFAULT NULL,
        "createdAt"           timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"           timestamptz  NOT NULL DEFAULT now(),

        CONSTRAINT "pk_notification_outbox_events"
          PRIMARY KEY ("id"),

        CONSTRAINT "uq_notification_outbox_idempotency_key"
          UNIQUE ("idempotencyKey"),

        CONSTRAINT "chk_notification_outbox_status_valid"
          CHECK ("status" IN ('PENDING','PROCESSING','DISPATCHED','DEAD_LETTER')),

        CONSTRAINT "chk_notification_outbox_retry_nonneg"
          CHECK ("retryCount" >= 0),

        CONSTRAINT "chk_notification_outbox_max_retries_positive"
          CHECK ("maxRetries" > 0),

        CONSTRAINT "chk_notification_outbox_retry_lte_max"
          CHECK ("retryCount" <= "maxRetries")
      )
    `);

    // ── Indexes ─────────────────────────────────────────────────────────────

    // Primary polling query: WHERE status='PENDING' AND scheduledAt <= now()
    // ORDER BY scheduledAt ASC, createdAt ASC (FOR UPDATE SKIP LOCKED)
    await queryRunner.query(`
      CREATE INDEX "idx_notification_outbox_pending_scheduled"
        ON "notification_outbox_events" ("status", "scheduledAt")
    `);

    // Crash-recovery query: WHERE status='PROCESSING' AND processingDeadline < now()
    await queryRunner.query(`
      CREATE INDEX "idx_notification_outbox_processing_deadline"
        ON "notification_outbox_events" ("status", "processingDeadline")
    `);

    // Aggregate-scoped lookups (health checks, replay, audit queries)
    await queryRunner.query(`
      CREATE INDEX "idx_notification_outbox_aggregate"
        ON "notification_outbox_events" ("aggregateId")
    `);

    // ── Auto-update trigger ────────────────────────────────────────────────
    //
    // Created idempotently so that other tables may share the function.
    // The trigger is DROP'd in down() but the function is intentionally kept.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_outbox_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        NEW."updatedAt" = now();
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_notification_outbox_updated_at"
      BEFORE UPDATE ON "notification_outbox_events"
      FOR EACH ROW EXECUTE FUNCTION set_outbox_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_notification_outbox_updated_at" ON "notification_outbox_events"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_outbox_aggregate"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_outbox_processing_deadline"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_outbox_pending_scheduled"`,
    );
    await queryRunner.query(`DROP TABLE "notification_outbox_events"`);
    // Note: set_outbox_updated_at() is intentionally NOT dropped — other
    // tables may share it. Remove manually when all consumers are gone.
  }
}
