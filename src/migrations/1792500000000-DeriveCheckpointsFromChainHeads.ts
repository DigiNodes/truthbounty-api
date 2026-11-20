import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeriveCheckpointsFromChainHeads1792500000000 implements MigrationInterface {
  name = 'DeriveCheckpointsFromChainHeads1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      ADD COLUMN "lastProcessedBlock" bigint NOT NULL DEFAULT 0,
      ADD COLUMN "observedHead" bigint,
      ADD COLUMN "headSource" character varying(128),
      ADD COLUMN "headsObservedAt" timestamp
    `);
    await queryRunner.query(`
      UPDATE "v2_event_checkpoints"
      SET "lastProcessedBlock" = GREATEST("lastSafeBlock", "lastFinalizedBlock")
    `);
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      ADD CONSTRAINT "chk_v2_checkpoint_processed_nonneg"
      CHECK ("lastProcessedBlock" >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      DROP CONSTRAINT "chk_v2_checkpoint_processed_nonneg"
    `);
    await queryRunner.query(`
      ALTER TABLE "v2_event_checkpoints"
      DROP COLUMN "headsObservedAt",
      DROP COLUMN "headSource",
      DROP COLUMN "observedHead",
      DROP COLUMN "lastProcessedBlock"
    `);
  }
}
