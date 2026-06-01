import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a nullable `payload` column to processed_events so the indexer can
 * reverse the exact state mutation an event applied when rolling back a reorg.
 */
export class AddProcessedEventPayload1769500000002 implements MigrationInterface {
  name = 'AddProcessedEventPayload1769500000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "processed_events" ADD "payload" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "processed_events" DROP COLUMN "payload"`);
  }
}
