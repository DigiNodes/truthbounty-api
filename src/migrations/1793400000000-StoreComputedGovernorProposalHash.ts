import { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreComputedGovernorProposalHash1793400000000 implements MigrationInterface {
  name = 'StoreComputedGovernorProposalHash1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "v2_governance_proposals" ADD COLUMN IF NOT EXISTS "descriptionHash" varchar(66)`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_governance_proposals" ADD COLUMN IF NOT EXISTS "proposalHashScheme" varchar(64)`,
    );
    await queryRunner.query(
      `UPDATE "v2_governance_proposals"
         SET "descriptionHash" = "proposalHash",
             "proposalHash" = '',
             "proposalHashScheme" = NULL
       WHERE "descriptionHash" IS NULL
         AND "proposalHash" IS NOT NULL
         AND "proposalHash" <> ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "v2_governance_proposals" DROP COLUMN IF EXISTS "proposalHashScheme"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_governance_proposals" DROP COLUMN IF EXISTS "descriptionHash"`,
    );
  }
}
