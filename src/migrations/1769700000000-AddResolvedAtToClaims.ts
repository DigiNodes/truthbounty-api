import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-219 — Add missing resolvedAt column to the claims table.
 *
 * The Claim entity declared `resolvedAt: Date | null` but the original
 * CreateUserAndWallet migration never added the column to the database.
 * This migration closes that gap.
 *
 * Protocol invariants enforced:
 *  - NULL  → claim is unresolved (PENDING state)
 *  - NOT NULL → claim has been resolved or finalized at least once
 */
export class AddResolvedAtToClaims1769700000000 implements MigrationInterface {
  name = 'AddResolvedAtToClaims1769700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the column as nullable — existing rows will default to NULL (unresolved)
    await queryRunner.query(
      `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "claims" DROP COLUMN IF EXISTS "resolvedAt"`,
    );
  }
}
