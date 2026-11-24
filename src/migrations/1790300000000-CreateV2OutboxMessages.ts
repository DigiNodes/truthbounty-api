import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-113: Transactional Outbox — create `v2_outbox_messages` table.
 *
 * ## Purpose
 *
 * This table is the durable record of side-effects (e.g. notification
 * dispatch, webhook fire, realtime broadcast) that must be delivered at
 * least once after a state-changing TypeORM transaction commits.
 *
 * A domain service writes a row into this table **inside the same
 * EntityManager transaction** as its state change.  Because both writes share
 * a single PostgreSQL commit, they are atomic: either both are durable or
 * neither is.  The V2OutboxWorker polls the table, claims rows with
 * `FOR UPDATE SKIP LOCKED`, dispatches them to BullMQ, and transitions them
 * to DISPATCHED or DEAD_LETTER.
 *
 * ## Schema notes
 *
 * - `idempotency_key` (UNIQUE): prevents duplicate outbox rows for the same
 *   logical event at the DB level; also used as the BullMQ jobId prefix for
 *   queue-level deduplication.
 * - `status` (CHECK): only the four valid states are accepted; unknown values
 *   are rejected at the database layer before the application can act on them.
 * - `processing_deadline`: set when a worker claims a row; stale PROCESSING
 *   rows past this deadline are reset to PENDING by the recovery pass.
 * - `chk_v2_outbox_retry_lte_max`: enforces the invariant that retryCount can
 *   never exceed maxRetries at the database level.
 *
 * ## Scope
 *
 * TypeORM/PostgreSQL persistence boundary only.  This migration does not
 * touch the Prisma/SQLite datasource (which manages the existing
 * `outbox_events` table used by the notifications module).  The two outbox
 * tables are completely independent and serve different consumers.
 *
 * ## Rollback safety
 *
 * The `down()` method is a clean DROP — safe as long as no other migration
 * references this table.  In production, drain the queue before rolling back
 * to avoid losing PENDING / PROCESSING rows.
 */
export class CreateV2OutboxMessages1790300000000 implements MigrationInterface {
  name = 'CreateV2OutboxMessages1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_outbox_messages" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "aggregateType"       varchar(128) NOT NULL,
        "aggregateId"         varchar(128) NOT NULL,
        "eventType"           varchar(128) NOT NULL,
        "payload"             json         NOT NULL DEFAULT '{}',
        "idempotencyKey"      varchar(64)  NOT NULL,
        "status"              varchar(16)  NOT NULL DEFAULT 'PENDING',
        "retryCount"          integer      NOT NULL DEFAULT 0,
        "maxRetries"          integer      NOT NULL DEFAULT 5,
        "lastError"           text                  DEFAULT NULL,
        "jobId"               varchar(256)          DEFAULT NULL,
        "scheduledAt"         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processingDeadline"  TIMESTAMP             DEFAULT NULL,
        "processedAt"         TIMESTAMP             DEFAULT NULL,
        "createdAt"           TIMESTAMP    NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP    NOT NULL DEFAULT now(),
        CONSTRAINT "pk_v2_outbox_messages"
          PRIMARY KEY ("id"),
        CONSTRAINT "uq_v2_outbox_idempotency_key"
          UNIQUE ("idempotencyKey"),
        CONSTRAINT "chk_v2_outbox_status_valid"
          CHECK ("status" IN ('PENDING','PROCESSING','DISPATCHED','DEAD_LETTER')),
        CONSTRAINT "chk_v2_outbox_retry_nonneg"
          CHECK ("retryCount" >= 0),
        CONSTRAINT "chk_v2_outbox_max_retries_positive"
          CHECK ("maxRetries" > 0),
        CONSTRAINT "chk_v2_outbox_retry_lte_max"
          CHECK ("retryCount" <= "maxRetries")
      )
    `);

    // Composite index for the primary polling query:
    //   WHERE status = 'PENDING' AND scheduledAt <= now()
    //   ORDER BY scheduledAt ASC, createdAt ASC
    await queryRunner.query(`
      CREATE INDEX "idx_v2_outbox_pending_scheduled"
        ON "v2_outbox_messages" ("status", "scheduledAt")
    `);

    // Index for the crash-recovery query:
    //   WHERE status = 'PROCESSING' AND processingDeadline < now()
    await queryRunner.query(`
      CREATE INDEX "idx_v2_outbox_processing_deadline"
        ON "v2_outbox_messages" ("status", "processingDeadline")
    `);

    // Index for aggregate-scoped lookups (health checks, replay, debug queries).
    await queryRunner.query(`
      CREATE INDEX "idx_v2_outbox_aggregate"
        ON "v2_outbox_messages" ("aggregateType", "aggregateId")
    `);

    // Trigger to keep "updatedAt" current on every row update.
    // Uses a shared or new update-timestamp function (created idempotently).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION v2_set_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        NEW."updatedAt" = now();
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_v2_outbox_updated_at"
      BEFORE UPDATE ON "v2_outbox_messages"
      FOR EACH ROW EXECUTE FUNCTION v2_set_updated_at()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_v2_outbox_updated_at" ON "v2_outbox_messages"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_outbox_aggregate"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_outbox_processing_deadline"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_outbox_pending_scheduled"`,
    );
    await queryRunner.query(
      `DROP TABLE "v2_outbox_messages"`,
    );
    // Note: v2_set_updated_at() is intentionally NOT dropped here because
    // other tables (present or future) may share it. Remove manually if this
    // is the last consumer.
  }
}
