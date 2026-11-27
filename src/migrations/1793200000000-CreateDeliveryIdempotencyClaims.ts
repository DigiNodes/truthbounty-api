import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-128: durable per notification/recipient/channel delivery claims.
 *
 * PostgreSQL is the correctness boundary for notification idempotency. Redis
 * and BullMQ job ids remain optimizations. The unique `idempotencyKey` plus the
 * `claimId`/`claimExpiresAt` lease columns let exactly one worker move a row to
 * PROCESSING and let a crashed worker's lease expire without a duplicate send.
 */
export class CreateDeliveryIdempotencyClaims1793200000000 implements MigrationInterface {
  name = 'CreateDeliveryIdempotencyClaims1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "delivery_history" (
        "id"                  uuid         NOT NULL DEFAULT gen_random_uuid(),
        "notificationId"      varchar      NOT NULL,
        "recipientId"         varchar,
        "eventType"           varchar,
        "aggregateId"         varchar,
        "channel"             varchar(20)  NOT NULL,
        "status"              varchar(20)  NOT NULL DEFAULT 'pending',
        "retryAttempts"       integer      NOT NULL DEFAULT 0,
        "lastRetryAt"         timestamp,
        "nextAttemptAt"       timestamp,
        "deliveredAt"         timestamp,
        "failureReason"       varchar,
        "providerUnconfirmed" boolean      NOT NULL DEFAULT false,
        "claimId"             varchar,
        "claimedAt"           timestamp,
        "claimExpiresAt"      timestamp,
        "metadata"            jsonb,
        "idempotencyKey"      varchar,
        "createdAt"           timestamp    NOT NULL DEFAULT now(),
        "updatedAt"           timestamp    NOT NULL DEFAULT now(),
        CONSTRAINT "pk_delivery_history" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "delivery_history"
        ADD COLUMN IF NOT EXISTS "recipientId" varchar,
        ADD COLUMN IF NOT EXISTS "eventType" varchar,
        ADD COLUMN IF NOT EXISTS "aggregateId" varchar,
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamp,
        ADD COLUMN IF NOT EXISTS "providerUnconfirmed" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "claimId" varchar,
        ADD COLUMN IF NOT EXISTS "claimedAt" timestamp,
        ADD COLUMN IF NOT EXISTS "claimExpiresAt" timestamp,
        ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now()
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_delivery_history_idempotency_key"
        ON "delivery_history" ("idempotencyKey")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_delivery_history_claim_lease"
        ON "delivery_history" ("status", "claimExpiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_delivery_history_claim_lease"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_delivery_history_idempotency_key"`,
    );
    // The remaining columns are dropped only if this migration created the
    // table; production rollback must drain delivery workers first.
    await queryRunner.query(`
      ALTER TABLE "delivery_history"
        DROP COLUMN IF EXISTS "claimExpiresAt",
        DROP COLUMN IF EXISTS "claimedAt",
        DROP COLUMN IF EXISTS "claimId",
        DROP COLUMN IF EXISTS "providerUnconfirmed",
        DROP COLUMN IF EXISTS "nextAttemptAt",
        DROP COLUMN IF EXISTS "aggregateId",
        DROP COLUMN IF EXISTS "eventType",
        DROP COLUMN IF EXISTS "recipientId"
    `);
  }
}
