import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-162 — make legacy dispute outcomes projections of finalized
 * canonical contract events.
 *
 * Existing rows were created from HTTP requests and have no canonical
 * provenance, so they are labelled LEGACY_WORKFLOW / LOCAL_WORKFLOW. Any
 * historical locally-set outcome is archived inside metadata under
 * `legacyOutcome` and the authoritative columns are cleared: no local terminal
 * state survives without canonical support. New writes only happen through
 * DisputeEvidenceService-validated canonical logs.
 */
export class DisputeCanonicalOutcomes1793300000000 implements MigrationInterface {
  name = 'DisputeCanonicalOutcomes1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "disputes"
      ADD COLUMN IF NOT EXISTS "recordKind" VARCHAR(32) NOT NULL DEFAULT 'LEGACY_WORKFLOW',
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(32) NOT NULL DEFAULT 'LOCAL_WORKFLOW',
      ADD COLUMN IF NOT EXISTS "chainId" INT NULL,
      ADD COLUMN IF NOT EXISTS "deploymentAddress" VARCHAR(42) NULL,
      ADD COLUMN IF NOT EXISTS "artifactVersion" VARCHAR(64) NULL,
      ADD COLUMN IF NOT EXISTS "canonicalClaimId" VARCHAR(66) NULL,
      ADD COLUMN IF NOT EXISTS "originalRoundId" VARCHAR(66) NULL,
      ADD COLUMN IF NOT EXISTS "eventTxHash" VARCHAR(66) NULL,
      ADD COLUMN IF NOT EXISTS "eventLogIndex" INT NULL,
      ADD COLUMN IF NOT EXISTS "eventBlockNumber" VARCHAR(78) NULL
    `);

    await queryRunner.query(`
      UPDATE "disputes"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb)
          || jsonb_build_object(
               'legacyOutcome', "outcome",
               'legacyFinalConfidence', "finalConfidence",
               'legacyResolvedAt', "resolvedAt",
               'nonAuthoritative', true
             ),
          "status" = 'OPEN',
          "outcome" = NULL,
          "finalConfidence" = NULL,
          "resolvedAt" = NULL
      WHERE "recordKind" = 'LEGACY_WORKFLOW'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_disputes_canonical_event_identity"
      ON "disputes" ("chainId", "eventTxHash", "eventLogIndex")
      WHERE "eventTxHash" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_disputes_canonical_claim"
      ON "disputes" ("chainId", "canonicalClaimId", "originalRoundId")
      WHERE "canonicalClaimId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_disputes_canonical_claim"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_disputes_canonical_event_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
      DROP COLUMN IF EXISTS "recordKind",
      DROP COLUMN IF EXISTS "dataState",
      DROP COLUMN IF EXISTS "chainId",
      DROP COLUMN IF EXISTS "deploymentAddress",
      DROP COLUMN IF EXISTS "artifactVersion",
      DROP COLUMN IF EXISTS "canonicalClaimId",
      DROP COLUMN IF EXISTS "originalRoundId",
      DROP COLUMN IF EXISTS "eventTxHash",
      DROP COLUMN IF EXISTS "eventLogIndex",
      DROP COLUMN IF EXISTS "eventBlockNumber"
    `);
  }
}
