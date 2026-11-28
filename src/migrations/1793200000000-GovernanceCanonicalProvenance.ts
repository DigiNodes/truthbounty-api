import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-161 — bind governance rows to verified identity and canonical
 * event provenance, and label off-chain drafts explicitly.
 *
 * Existing rows are backfilled conservatively: legacy proposals become
 * OFFCHAIN_DRAFT / DRAFT (they were never proven to be on-chain) and legacy
 * votes keep their historical numeric weight as a decimal string. New writes
 * are only produced from validated canonical events with finalized checkpoints.
 */
export class GovernanceCanonicalProvenance1793200000000 implements MigrationInterface {
  name = 'GovernanceCanonicalProvenance1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "proposals"
      ADD COLUMN IF NOT EXISTS "recordKind" VARCHAR(32) NOT NULL DEFAULT 'OFFCHAIN_DRAFT',
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
      ADD COLUMN IF NOT EXISTS "chainId" INT NULL,
      ADD COLUMN IF NOT EXISTS "governorAddress" VARCHAR(42) NULL,
      ADD COLUMN IF NOT EXISTS "canonicalProposalId" VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS "creationLogIndex" INT NULL,
      ADD COLUMN IF NOT EXISTS "creationBlockNumber" VARCHAR(78) NULL,
      ADD COLUMN IF NOT EXISTS "artifactVersion" VARCHAR(64) NULL,
      ADD COLUMN IF NOT EXISTS "voteWeightFor" VARCHAR(78) NOT NULL DEFAULT '0',
      ADD COLUMN IF NOT EXISTS "voteWeightAgainst" VARCHAR(78) NOT NULL DEFAULT '0',
      ADD COLUMN IF NOT EXISTS "voteWeightAbstain" VARCHAR(78) NOT NULL DEFAULT '0'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_proposals_canonical_identity"
      ON "proposals" ("chainId", "canonicalProposalId")
      WHERE "canonicalProposalId" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "votes"
      ADD COLUMN IF NOT EXISTS "supportMode" VARCHAR(16) NOT NULL DEFAULT 'FOR',
      ADD COLUMN IF NOT EXISTS "chainId" INT NULL,
      ADD COLUMN IF NOT EXISTS "governorAddress" VARCHAR(42) NULL,
      ADD COLUMN IF NOT EXISTS "canonicalProposalId" VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS "txHash" VARCHAR(66) NULL,
      ADD COLUMN IF NOT EXISTS "logIndex" INT NULL,
      ADD COLUMN IF NOT EXISTS "blockNumber" VARCHAR(78) NULL,
      ADD COLUMN IF NOT EXISTS "artifactVersion" VARCHAR(64) NULL,
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(32) NOT NULL DEFAULT 'FINALIZED'
    `);

    // Keep the exact uint256 value as text; decimal(10,2) silently lost weight.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'votes' AND column_name = 'weight' AND data_type = 'numeric'
        ) THEN
          ALTER TABLE "votes"
          ALTER COLUMN "weight" TYPE VARCHAR(78)
          USING TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM "weight"::text));
        END IF;
      END $$
    `);
    await queryRunner.query(`
      ALTER TABLE "votes" ALTER COLUMN "weight" SET DEFAULT '0'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_votes_canonical_event_identity"
      ON "votes" (
        "chainId", "governorAddress", "canonicalProposalId", "voter", "txHash", "logIndex"
      )
      WHERE "chainId" IS NOT NULL AND "txHash" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_votes_canonical_event_identity"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_proposals_canonical_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "votes"
      DROP COLUMN IF EXISTS "supportMode",
      DROP COLUMN IF EXISTS "chainId",
      DROP COLUMN IF EXISTS "governorAddress",
      DROP COLUMN IF EXISTS "canonicalProposalId",
      DROP COLUMN IF EXISTS "txHash",
      DROP COLUMN IF EXISTS "logIndex",
      DROP COLUMN IF EXISTS "blockNumber",
      DROP COLUMN IF EXISTS "artifactVersion",
      DROP COLUMN IF EXISTS "dataState"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'votes' AND column_name = 'weight' AND data_type = 'character varying'
        ) THEN
          ALTER TABLE "votes"
          ALTER COLUMN "weight" TYPE NUMERIC(10,2)
          USING COALESCE("weight"::numeric, 0);
        END IF;
      END $$
    `);
    await queryRunner.query(`
      ALTER TABLE "votes" ALTER COLUMN "weight" SET DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "proposals"
      DROP COLUMN IF EXISTS "recordKind",
      DROP COLUMN IF EXISTS "dataState",
      DROP COLUMN IF EXISTS "chainId",
      DROP COLUMN IF EXISTS "governorAddress",
      DROP COLUMN IF EXISTS "canonicalProposalId",
      DROP COLUMN IF EXISTS "creationLogIndex",
      DROP COLUMN IF EXISTS "creationBlockNumber",
      DROP COLUMN IF EXISTS "artifactVersion",
      DROP COLUMN IF EXISTS "voteWeightFor",
      DROP COLUMN IF EXISTS "voteWeightAgainst",
      DROP COLUMN IF EXISTS "voteWeightAbstain"
    `);
  }
}
