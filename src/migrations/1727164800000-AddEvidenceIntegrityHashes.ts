import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-013: Add integrity hash columns to evidence entities.
 *
 * This migration adds cryptographic integrity verification to evidence
 * projections while preserving the chain-authoritative, append-only architecture.
 *
 * Phase 1 (this migration): Add nullable columns for backward compatibility
 * Phase 2 (backfill): Stamp existing records via EvidenceIntegrityService
 * Phase 3 (enforcement): Make columns NOT NULL with CHECK constraints
 *
 * @see docs/V2_EVIDENCE_INTEGRITY_DESIGN.md
 */
export class AddEvidenceIntegrityHashes1727164800000 implements MigrationInterface {
  name = 'AddEvidenceIntegrityHashes1727164800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add integrity hash columns to ProjectEvidenceVersion
    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence_version"
        ADD COLUMN "integrityHash" varchar(64) NULL,
        ADD COLUMN "previousVersionHash" varchar(64) NULL
    `);

    // Add integrity hash column to ProjectEvidence
    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence"
        ADD COLUMN "integrityHash" varchar(64) NULL
    `);

    // Create indexes for integrity verification queries
    await queryRunner.query(`
      CREATE INDEX "idx_v2_evidence_version_integrity"
        ON "v2_project_evidence_version" ("evidenceId", "version", "integrityHash")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_v2_evidence_integrity"
        ON "v2_project_evidence" ("evidenceId", "integrityHash")
    `);

    // Add comment documentation for operators
    await queryRunner.query(`
      COMMENT ON COLUMN "v2_project_evidence_version"."integrityHash" IS
        'SHA-256 hash of version-specific canonical fields. Computed from: evidenceId, version, contentDigest, safeMetadataUri, submittedBy, eventTxHash, eventLogIndex, blockNumber, previousVersionHash. NULL during backfill; NOT NULL after enforcement. See V2_EVIDENCE_INTEGRITY_DESIGN.md'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "v2_project_evidence_version"."previousVersionHash" IS
        'Hash of previous version for chain-of-custody. NULL for version 1, otherwise contains integrityHash of version N-1. Enables tamper detection.'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "v2_project_evidence"."integrityHash" IS
        'SHA-256 hash of current-state projection fields. Computed from: evidenceId, claimId, currentVersion, status, contentDigest, lastEventBlockNumber, lastEventLogIndex. NULL during backfill; NOT NULL after enforcement.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_v2_evidence_integrity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_v2_evidence_version_integrity"`);

    // Remove columns
    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence"
        DROP COLUMN IF EXISTS "integrityHash"
    `);

    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence_version"
        DROP COLUMN IF EXISTS "previousVersionHash",
        DROP COLUMN IF EXISTS "integrityHash"
    `);
  }
}
