import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-019: durable checkpoint + audit row for projection rebuilds.
 *
 * One row per rebuild attempt. The deterministic report is stored both as
 * queryable columns (so a run can be alerted on or listed without parsing
 * JSON) and as the full serialised checkpoint in `checkpointJson`.
 *
 * This table is the *record* of a rebuild; it is never read by a serving read
 * path, so a row existing does not make a rebuild authoritative. Only the
 * documented cutover procedure — an operator action — can make a rebuilt read
 * model live.
 */
export class CreateProjectionRebuildRuns1788200000000
  implements MigrationInterface
{
  name = 'CreateProjectionRebuildRuns1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_projection_rebuild_runs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chainId" integer NOT NULL,
        "status" varchar(16) NOT NULL,
        "targetSchema" varchar(128) NULL,
        "deploymentBlock" varchar(32) NOT NULL,
        "fromBlock" varchar(32) NOT NULL,
        "toBlock" varchar(32) NULL,
        "inputDigest" varchar(64) NOT NULL,
        "batchesProcessed" integer NOT NULL DEFAULT 0,
        "eventsConsumed" integer NOT NULL DEFAULT 0,
        "eventsApplied" integer NOT NULL DEFAULT 0,
        "eventsSkipped" integer NOT NULL DEFAULT 0,
        "anomalies" integer NOT NULL DEFAULT 0,
        "safeToCutover" boolean NOT NULL DEFAULT false,
        "checkpointJson" text NOT NULL,
        "error" text NULL,
        "startedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "finishedAt" TIMESTAMP NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_rebuild_runs_chain_status" ON "v2_projection_rebuild_runs" ("chainId", "status")`,
    );
    // Resuming looks up the most recent non-completed run for a chain, so the
    // index is on the startedAt ordering within a chain rather than on status
    // alone.
    await queryRunner.query(
      `CREATE INDEX "idx_v2_rebuild_runs_chain_started" ON "v2_projection_rebuild_runs" ("chainId", "startedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_projection_rebuild_runs"`);
  }
}
