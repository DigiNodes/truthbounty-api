import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventCheckpointHashes1792400000000 implements MigrationInterface {
  name = 'AddEventCheckpointHashes1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      ADD COLUMN "lastSafeBlockHash" character varying(66),
      ADD COLUMN "lastFinalizedBlockHash" character varying(66)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      DROP COLUMN "lastFinalizedBlockHash",
      DROP COLUMN "lastSafeBlockHash"
    `);
  }
}
