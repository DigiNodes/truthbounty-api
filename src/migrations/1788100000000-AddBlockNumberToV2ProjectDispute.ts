import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the chain-native block coordinate to the projected dispute read model.
 *
 * DisputeProjectorService keyset-paginates and labels data state by
 * (blockNumber, logIndex), but the original table only stored eventLogIndex,
 * so a projected dispute had no reproducible block coordinate at all. The
 * column is added nullable and backfilled from v2_canonical_events -- the
 * canonical stream, not from any API-side guess -- so existing rows either
 * get a verifiable block or stay explicitly unknown (and are reported as
 * OBSERVED rather than finalized).
 */
export class AddBlockNumberToV2ProjectDispute1788100000000 implements MigrationInterface {
  name = 'AddBlockNumberToV2ProjectDispute1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "v2_project_dispute" ADD COLUMN "blockNumber" bigint NULL`,
    );

    // Backfill from the canonical event that produced each row. Only rows
    // whose originating event is still present in the canonical stream get a
    // block; anything else remains NULL (unknown provenance).
    await queryRunner.query(`
      UPDATE "v2_project_dispute" AS d
      SET "blockNumber" = e."blockNumber"
      FROM "v2_canonical_events" AS e
      WHERE e."txHash" = d."eventTxHash"
        AND e."logIndex" = d."eventLogIndex"
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_v2_project_dispute_block_number" ON "v2_project_dispute" ("blockNumber")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_v2_project_dispute_block_number"`);
    await queryRunner.query(
      `ALTER TABLE "v2_project_dispute" DROP COLUMN "blockNumber"`,
    );
  }
}
