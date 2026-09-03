import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerificationDisputeEnhancements1769800400000 implements MigrationInterface {
  name = 'AddVerificationDisputeEnhancements1769800400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add columns to v2_project_verification_rounds
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_rounds"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed',
      ADD COLUMN "totalStake" VARCHAR(100),
      ADD COLUMN "totalEffectiveWeight" VARCHAR(100),
      ADD COLUMN "roundSnapshot" JSON,
      ADD COLUMN "appealDeadline" TIMESTAMP
    `);

    // Add dataState column to v2_project_participant_positions
    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_positions"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed'
    `);

    // Add dataState column to v2_project_disputes
    await queryRunner.query(`
      ALTER TABLE "v2_project_disputes"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove columns from v2_project_verification_rounds
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_rounds"
      DROP COLUMN "dataState",
      DROP COLUMN "totalStake",
      DROP COLUMN "totalEffectiveWeight",
      DROP COLUMN "roundSnapshot",
      DROP COLUMN "appealDeadline"
    `);

    // Remove dataState column from v2_project_participant_positions
    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_positions"
      DROP COLUMN "dataState"
    `);

    // Remove dataState column from v2_project_disputes
    await queryRunner.query(`
      ALTER TABLE "v2_project_disputes"
      DROP COLUMN "dataState"
    `);
  }
}