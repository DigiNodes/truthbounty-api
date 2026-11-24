import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-001: one canonical finalized-block cursor per (chain, release).
 * Observed, safe and finalized heads are stored separately from the indexed
 * watermark; every row is bound to the release deployment block and
 * artifact checksum.
 */
export class CreateV2FinalizedCursors1725000002000 implements MigrationInterface {
  name = 'CreateV2FinalizedCursors1725000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "v2_finalized_cursors" (
            "chain_id" INT NOT NULL,
            "release_id" VARCHAR(64) NOT NULL,
            "deployment_block" BIGINT NOT NULL,
            "artifact_checksum" CHAR(64) NOT NULL,
            "observed_head" BIGINT,
            "safe_head" BIGINT,
            "finalized_head" BIGINT,
            "heads_observed_at" TIMESTAMP WITH TIME ZONE,
            "indexed_watermark" BIGINT NOT NULL,
            "watermark_block_hash" VARCHAR(66),
            "watermark_updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "PK_v2_finalized_cursors" PRIMARY KEY ("chain_id", "release_id"),
            CONSTRAINT "CHK_finalized_cursor_chain" CHECK ("chain_id" > 0),
            CONSTRAINT "CHK_finalized_cursor_deployment" CHECK ("deployment_block" >= 0),
            CONSTRAINT "CHK_finalized_cursor_heads_order" CHECK (
              "finalized_head" IS NULL
              OR ("safe_head" >= "finalized_head" AND "observed_head" >= "safe_head")
            ),
            CONSTRAINT "CHK_finalized_cursor_watermark_floor" CHECK (
              "indexed_watermark" >= "deployment_block" - 1
            )
        );`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_finalized_cursors";`);
  }
}
