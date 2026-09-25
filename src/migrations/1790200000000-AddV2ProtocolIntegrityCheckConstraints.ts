import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-114: Encode Protocol Integrity in PostgreSQL Constraints.
 *
 * Scope note: this covers the TypeORM/PostgreSQL tables only. A separate,
 * unrelated set of tables (users, wallets, the outbox, and others) are
 * persisted through Prisma against a SQLite datasource, not through this
 * TypeORM connection, and are out of reach of a migration in this
 * migration path. See ARCHITECTURE.md's persistence-boundary section.
 *
 * Every constraint here mirrors a `@Check(...)` decorator already added to
 * the corresponding entity (so `synchronize: true` dev/test databases get
 * the same guarantee), matching an app-level TypeScript enum or an
 * invariant ("a round number is always positive") that was previously only
 * enforced by application code. A bug in that code, a raw SQL statement, a
 * bad migration, or a different write path entirely could otherwise put an
 * invalid value in one of these columns; the CHECK makes that a rejected
 * write instead of corrupted protocol-derived state.
 *
 * This migration also depends on the table-name fix in
 * AddVerificationDisputeEnhancements (1769800400000): that migration
 * previously referenced "v2_project_verification_rounds" /
 * "..._positions" / "..._disputes" (plural), which do not exist; only
 * the singular tables created in CreateV2VerificationTables /
 * CreateV2DisputesTables do. Against a real Postgres database that
 * migration would have failed outright, so "dataState", itself part of
 * this repo's reorg-safety story, could never have been persisted. That
 * bug is fixed directly in 1769800400000 rather than worked around here.
 */
export class AddV2ProtocolIntegrityCheckConstraints1790200000000 implements MigrationInterface {
  name = 'AddV2ProtocolIntegrityCheckConstraints1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_round"
      ADD CONSTRAINT "chk_v2_round_status" CHECK ("status" IN ('open', 'closed', 'resolved')),
      ADD CONSTRAINT "chk_v2_round_type" CHECK ("roundType" IN ('first', 'appeal')),
      ADD CONSTRAINT "chk_v2_round_data_state" CHECK ("dataState" IN ('observed', 'safe', 'finalized')),
      ADD CONSTRAINT "chk_v2_round_number_positive" CHECK ("roundNumber" > 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      ADD CONSTRAINT "chk_v2_dispute_status" CHECK ("status" IN ('raised', 'resolved', 'expired')),
      ADD CONSTRAINT "chk_v2_dispute_data_state" CHECK ("dataState" IN ('observed', 'safe', 'finalized'))
    `);

    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_position"
      ADD CONSTRAINT "chk_v2_position_data_state" CHECK ("dataState" IN ('observed', 'safe', 'finalized'))
    `);

    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence"
      ADD CONSTRAINT "chk_v2_evidence_status" CHECK ("status" IN ('active', 'removed')),
      ADD CONSTRAINT "chk_v2_evidence_version_positive" CHECK ("currentVersion" > 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "v2_project_evidence_version"
      ADD CONSTRAINT "chk_v2_evidence_version_number_positive" CHECK ("version" > 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "v2_project_evidence_version" DROP CONSTRAINT "chk_v2_evidence_version_number_positive"`,
    );

    await queryRunner.query(
      `ALTER TABLE "v2_project_evidence" DROP CONSTRAINT "chk_v2_evidence_version_positive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_project_evidence" DROP CONSTRAINT "chk_v2_evidence_status"`,
    );

    await queryRunner.query(
      `ALTER TABLE "v2_project_participant_position" DROP CONSTRAINT "chk_v2_position_data_state"`,
    );

    await queryRunner.query(
      `ALTER TABLE "v2_project_dispute" DROP CONSTRAINT "chk_v2_dispute_data_state"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_project_dispute" DROP CONSTRAINT "chk_v2_dispute_status"`,
    );

    await queryRunner.query(
      `ALTER TABLE "v2_project_verification_round" DROP CONSTRAINT "chk_v2_round_number_positive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_project_verification_round" DROP CONSTRAINT "chk_v2_round_data_state"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_project_verification_round" DROP CONSTRAINT "chk_v2_round_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_project_verification_round" DROP CONSTRAINT "chk_v2_round_status"`,
    );
  }
}
