import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen `projection_events.aggregateId` to 200 characters.
 *
 * V2 projectors derive aggregate ids such as `${claimId}:${roundId}`
 * (66 + 1 + 66 = 133 chars), which overflow the original 128-character
 * column and were rejected by realtime validation. Widening the column and
 * the validation cap keeps REST row identity (`disputeId` PK, varchar 200)
 * and realtime delivery consistent.
 */
export class WidenProjectionEventAggregateId1788000001000
  implements MigrationInterface
{
  name = 'WidenProjectionEventAggregateId1788000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "projection_events"
      ALTER COLUMN "aggregateId" TYPE varchar(200)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "projection_events"
      ALTER COLUMN "aggregateId" TYPE varchar(128)
    `);
  }
}