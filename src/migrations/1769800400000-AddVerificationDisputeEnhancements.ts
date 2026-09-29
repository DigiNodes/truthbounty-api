import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerificationDisputeEnhancements1769800400000 implements MigrationInterface {
  name = 'AddVerificationDisputeEnhancements1769800400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add columns to v2_project_verification_round
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_round"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed',
      ADD COLUMN "totalStake" VARCHAR(100),
      ADD COLUMN "totalEffectiveWeight" VARCHAR(100),
      ADD COLUMN "roundSnapshot" JSON,
      ADD COLUMN "appealDeadline" TIMESTAMP
    `);

    // Add dataState column to v2_project_participant_position
    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_position"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed'
    `);

    // Add dataState column to v2_project_dispute
    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      ADD COLUMN "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove columns from v2_project_verification_round
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_round"
      DROP COLUMN "dataState",
      DROP COLUMN "totalStake",
      DROP COLUMN "totalEffectiveWeight",
      DROP COLUMN "roundSnapshot",
      DROP COLUMN "appealDeadline"
    `);

    // Remove dataState column from v2_project_participant_position
    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_position"
      DROP COLUMN "dataState"
    `);

    // Remove dataState column from v2_project_dispute
    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      DROP COLUMN "dataState"
    `);
  }
}
