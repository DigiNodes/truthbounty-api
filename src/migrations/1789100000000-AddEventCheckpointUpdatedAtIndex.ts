import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VerificationQueryService and DisputesQueryService both look up the latest
 * checkpoint via `ORDER BY "updatedAt" DESC LIMIT 1` (see FinalityPolicyService
 * / getLatestCheckpoint) to classify rows as OBSERVED/SAFE/FINALIZED. That
 * query had no supporting index, so it sequentially scanned+sorted
 * v2_event_checkpoints on every request.
 */
export class AddEventCheckpointUpdatedAtIndex1789100000000
  implements MigrationInterface
{
  name = 'AddEventCheckpointUpdatedAtIndex1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_v2_event_checkpoints_updated_at" ON "v2_event_checkpoints" ("updatedAt" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_v2_event_checkpoints_updated_at"`,
    );
  }
}
