import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: add `resolvedAt` column to `claims`.
 *
 * Invariant enforced at the application layer:
 *   resolvedAt IS NOT NULL  <=>  resolvedVerdict IS NOT NULL
 *
 * Backfill: any existing row where resolvedVerdict is already set gets
 * resolvedAt filled with createdAt as a conservative approximation
 * (the exact resolution timestamp was not stored before this migration).
 * Rows where resolvedVerdict IS NULL are left with resolvedAt = NULL.
 */
export class AddClaimResolvedAt1769600000000 implements MigrationInterface {
  name = 'AddClaimResolvedAt1769600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add the nullable column
    await queryRunner.query(
      `ALTER TABLE "claims" ADD COLUMN "resolvedAt" TIMESTAMP`,
    );

    // 2. Backfill: rows that already have a verdict set resolvedAt = createdAt
    //    (createdAt is the earliest safe approximation; actual resolution time
    //     was not recorded before this migration — noted in PR for #BE-219).
    await queryRunner.query(
      `UPDATE "claims" SET "resolvedAt" = "createdAt" WHERE "resolvedVerdict" IS NOT NULL`,
    );

    // 3. Partial index mirrors the pattern used on resolvedVerdict
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_resolved_at" ON "claims" ("resolvedAt") WHERE "resolvedAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_claims_resolved_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" DROP COLUMN "resolvedAt"`,
    );
  }
}
