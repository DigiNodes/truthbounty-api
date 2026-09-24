import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-132: add the chain-native blockNumber coordinate to the projected
 * dispute read model.
 *
 * v2_project_dispute previously lacked a blockNumber column while the
 * disputes query service already ordered and generated keyset cursors over
 * (blockNumber, eventLogIndex), so ordered reads and cursor pagination were
 * broken at runtime. This migration restores the coordinate so disputes have
 * the same stable, chain-native pagination key as the other V2 projections.
 */
export class AddBlockNumberToV2ProjectDispute1787000000000
  implements MigrationInterface
{
  name = 'AddBlockNumberToV2ProjectDispute1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      ADD COLUMN "blockNumber" bigint NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      DROP COLUMN "blockNumber"
    `);
  }
}