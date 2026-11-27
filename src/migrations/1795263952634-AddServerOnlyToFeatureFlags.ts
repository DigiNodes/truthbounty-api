import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddServerOnlyToFeatureFlags
 *
 * Adds the `serverOnly` column to the `feature_flags` table to support
 * server-only flags that cannot be enumerated or evaluated through public routes.
 *
 * This addresses PREWAVE-BE-157: Sanitize public feature-flag reads and evaluation context.
 *
 * Server-only flags are used for internal rollout controls, security-sensitive toggles,
 * and operational flags that should not be disclosed to unauthenticated callers.
 *
 * The default is `false`, meaning existing flags remain publicly accessible unless
 * explicitly marked as server-only by administrators.
 *
 * Rollback: removes the column entirely (no data loss risk — default was false).
 */
export class AddServerOnlyToFeatureFlags1795263952634
  implements MigrationInterface
{
  name = 'AddServerOnlyToFeatureFlags1795263952634';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add serverOnly column with default false to maintain backward compatibility.
    await queryRunner.query(`
      ALTER TABLE "feature_flags"
      ADD COLUMN IF NOT EXISTS "serverOnly" BOOLEAN NOT NULL DEFAULT false
    `);

    // Index for filtering server-only flags in public queries.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_feature_flags_serverOnly"
      ON "feature_flags" ("serverOnly")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_feature_flags_serverOnly"`,
    );
    await queryRunner.query(
      `ALTER TABLE "feature_flags" DROP COLUMN IF EXISTS "serverOnly"`,
    );
  }
}
