import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the reorg_events audit trail table.
 *
 * Every detected chain reorganisation is recorded here inside the same
 * transaction as the state rollback, so the record can never be orphaned
 * from the state it describes. The monotonically increasing `id` doubles
 * as the chronological cursor for operational dashboards and alert
 * aggregation.
 */
export class CreateReorgEventsTable1790000000000
  implements MigrationInterface
{
  name = 'CreateReorgEventsTable1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "reorg_events" (
        "id"                        SERIAL       NOT NULL,
        "reorg_depth"               INT          NOT NULL,
        "affected_block_start"      BIGINT       NOT NULL,
        "affected_block_end"        BIGINT       NOT NULL,
        "orphaned_event_count"      INT          NOT NULL,
        "replayed_event_count"      INT          NOT NULL DEFAULT 0,
        "canonical_hash_after_replay" VARCHAR(66) NULL,
        "completed_successfully"    BOOLEAN      NOT NULL DEFAULT FALSE,
        "error_message"             TEXT         NULL,
        "duration_ms"               INT          NULL,
        "detected_at"               TIMESTAMP    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reorg_events_id" PRIMARY KEY ("id")
      )
    `);

    // Chronological queries on dashboards and alert aggregation.
    await queryRunner.query(`
      CREATE INDEX "IDX_reorg_events_detected_at"
        ON "reorg_events" ("detected_at")
    `);
    // Range scans for "find reorgs that affected block X".
    await queryRunner.query(`
      CREATE INDEX "IDX_reorg_events_affected_range"
        ON "reorg_events" ("affected_block_start", "affected_block_end")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_reorg_events_affected_range"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_reorg_events_detected_at"`,
    );
    await queryRunner.query(`DROP TABLE "reorg_events"`);
  }
}
