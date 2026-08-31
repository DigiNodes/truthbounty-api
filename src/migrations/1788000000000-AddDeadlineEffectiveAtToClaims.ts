import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeadlineEffectiveAtToClaims1788000000000 implements MigrationInterface {
  name = 'AddDeadlineEffectiveAtToClaims1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "claims" ADD COLUMN "deadline" TIMESTAMP NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD COLUMN "effectiveAt" TIMESTAMP NULL`,
    );

    // Backfill effectiveAt from createdAt so existing rows have a sortable value
    await queryRunner.query(
      `UPDATE "claims" SET "effectiveAt" = "createdAt" WHERE "effectiveAt" IS NULL`,
    );

    // Index for stable feed ordering (descending by effectiveAt)
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_effective_at" ON "claims" ("effectiveAt" DESC)`,
    );

    // Composite index for cursor-based pagination: effectiveAt DESC, id DESC
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_effective_at_id" ON "claims" ("effectiveAt" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_claims_effective_at_id"`);
    await queryRunner.query(`DROP INDEX "IDX_claims_effective_at"`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "effectiveAt"`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "deadline"`);
  }
}
