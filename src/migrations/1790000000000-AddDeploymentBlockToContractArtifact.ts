import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-125 fix 1.6 — Adds `deploymentBlock` to `v2_contract_artifacts`.
 *
 * The backfill endpoint validates that the requested start block is >= the
 * contract's on-chain deployment block.  Rows inserted before this migration
 * will have NULL here; backfill validation treats NULL as "no lower bound"
 * (genesis), which is safe: it merely means operators cannot be warned about
 * pre-deployment requests for legacy rows.  New artifact registrations must
 * populate this field.
 *
 * Nullable so the column addition is non-breaking and zero-downtime on a live
 * database (no default forces a table rewrite on Postgres).
 */
export class AddDeploymentBlockToContractArtifact1790000000000
  implements MigrationInterface
{
  name = 'AddDeploymentBlockToContractArtifact1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add nullable bigint column — no table rewrite on Postgres.
    await queryRunner.query(`
      ALTER TABLE "v2_contract_artifacts"
      ADD COLUMN IF NOT EXISTS "deploymentBlock" BIGINT NULL
    `);

    // Index supports fast lookups by the controller validation query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_v2_contract_artifacts_deployment_block"
      ON "v2_contract_artifacts" ("chainId", "contractAddress", "deploymentBlock")
      WHERE "deploymentBlock" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_v2_contract_artifacts_deployment_block"
    `);
    await queryRunner.query(`
      ALTER TABLE "v2_contract_artifacts"
      DROP COLUMN IF EXISTS "deploymentBlock"
    `);
  }
}
