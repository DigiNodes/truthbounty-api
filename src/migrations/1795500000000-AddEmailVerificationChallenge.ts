import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API #621 / issue: Email Ownership Verification for Notification Channel
 *
 * Creates the `email_verification_challenges` table that backs the
 * single-use, time-limited ownership challenge flow for notification-email
 * addresses.
 *
 * Also adds `emailAddressVerified` to `notification_preferences` so the
 * delivery gate can distinguish confirmed from unconfirmed addresses without
 * touching the `email_verification_challenges` table on every delivery.
 *
 * Security notes:
 *  - `token_hash` is the SHA-256 hex digest; raw tokens are never persisted.
 *  - The partial unique index on (token_hash) WHERE state = 'PENDING' allows
 *    the same hash to appear in historical rows (VERIFIED / REVOKED / EXPIRED)
 *    without blocking a future challenge for a different address.
 *  - `email_address_verified` defaults to false so existing unverified
 *    addresses do not silently inherit the verified flag.
 */
export class AddEmailVerificationChallenge1795500000000
  implements MigrationInterface
{
  name = 'AddEmailVerificationChallenge1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── email_verification_challenges ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_verification_challenges" (
        "id"                   uuid         NOT NULL DEFAULT gen_random_uuid(),
        "userId"               varchar      NOT NULL,
        "tokenHash"            varchar(64)  NOT NULL,
        "pendingEmailAddress"  varchar      NOT NULL,
        "state"                varchar(16)  NOT NULL DEFAULT 'PENDING',
        "expiresAt"            timestamp    NOT NULL,
        "confirmedAt"          timestamp,
        "createdAt"            timestamp    NOT NULL DEFAULT now(),
        "updatedAt"            timestamp    NOT NULL DEFAULT now(),
        CONSTRAINT "pk_email_verification_challenges" PRIMARY KEY ("id")
      )
    `);

    // Index: look up by user + state (most common query pattern)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_evc_userId_state"
        ON "email_verification_challenges" ("userId", "state")
    `);

    // Index: used by scheduled expiry job and cleanup queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_evc_state_expiresAt"
        ON "email_verification_challenges" ("state", "expiresAt")
    `);

    // Partial unique index: at most one PENDING challenge per token hash.
    // Revoked/verified/expired hashes may coexist without violating uniqueness.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_evc_tokenHash_pending"
        ON "email_verification_challenges" ("tokenHash")
        WHERE "state" = 'PENDING'
    `);

    // ── notification_preferences: add verified flag ────────────────────────
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
        ADD COLUMN IF NOT EXISTS "emailAddressVerified" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove the verified flag from notification_preferences
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
        DROP COLUMN IF EXISTS "emailAddressVerified"
    `);

    // Drop challenge table and all its indexes (CASCADE handles them)
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_evc_tokenHash_pending"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_evc_state_expiresAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_evc_userId_state"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "email_verification_challenges"`,
    );
  }
}
