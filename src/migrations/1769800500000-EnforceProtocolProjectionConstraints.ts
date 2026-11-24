import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE issue396: enforce database schema constraints for protocol projections.
 *
 * Scope (focused, independently reviewable):
 * - Repair the broken 1769800400000 enhancement (it ALTERed plural
 *   `v2_project_verification_rounds/_positions/_disputes` while real tables
 *   are singular, so `dataState` et al never landed).
 * - Add the missing `blockNumber` + `dataState` columns on `v2_project_dispute`
 *   required by DisputesQueryService keyset pagination.
 * - Add FKs (version->evidence, position->round), UNIQUEs (event identity,
 *   anomaly dedup), CHECKs (ranges, enums, canonical identifiers), and
 *   immutable-final-state triggers at the DB boundary.
 *
 * Non-goals: no new projector logic, no settlement/rewards/treasury
 * authority, no Stellar/Soroban/Freighter deps, no Prisma drift (Prisma
 * remains canonical for User/Wallet/Sybil/AI/Analytics; V2 projections stay
 * in TypeORM and this migration adds constraints only, no new tables).
 *
 * Note: `v2_project_dispute.originalRoundId -> v2_project_verification_round`
 * FK is deliberately omitted: disputes tolerate out-of-order arrival via the
 * anomaly path (a round may not be projected yet), and a hard FK would turn
 * that observable anomaly into an unobservable insert failure.
 */
export class EnforceProtocolProjectionConstraints1769800500000 implements MigrationInterface {
  name = 'EnforceProtocolProjectionConstraints1769800500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Repair singular-table enhancement columns (idempotent).
    await queryRunner.query(`
      ALTER TABLE "v2_project_verification_round"
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed',
      ADD COLUMN IF NOT EXISTS "totalStake" VARCHAR(100),
      ADD COLUMN IF NOT EXISTS "totalEffectiveWeight" VARCHAR(100),
      ADD COLUMN IF NOT EXISTS "roundSnapshot" JSON,
      ADD COLUMN IF NOT EXISTS "appealDeadline" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "v2_project_participant_position"
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed'
    `);
    await queryRunner.query(`
      ALTER TABLE "v2_project_dispute"
      ADD COLUMN IF NOT EXISTS "dataState" VARCHAR(16) NOT NULL DEFAULT 'observed',
      ADD COLUMN IF NOT EXISTS "blockNumber" BIGINT NOT NULL DEFAULT 0
    `);

    // 2. UNIQUE constraints (canonical event identity + anomaly dedup).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_v2_dispute_event') THEN
          ALTER TABLE "v2_project_dispute"
          ADD CONSTRAINT "uq_v2_dispute_event" UNIQUE ("eventTxHash", "eventLogIndex");
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_v2_round_event') THEN
          ALTER TABLE "v2_project_verification_round"
          ADD CONSTRAINT "uq_v2_round_event" UNIQUE ("eventTxHash", "eventLogIndex");
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_v2_anomaly_identity') THEN
          ALTER TABLE "v2_indexing_anomalies"
          ADD CONSTRAINT "uq_v2_anomaly_identity" UNIQUE ("sourceModule", "kind", "aggregateId", "eventTxHash", "eventLogIndex");
        END IF;
      END $$;
    `);

    // 3. CHECK constraints (ranges, enums, canonical identifiers).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_canonical_chain_positive') THEN
          ALTER TABLE "v2_canonical_events" ADD CONSTRAINT "chk_v2_canonical_chain_positive" CHECK ("chainId" > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_canonical_log_nonneg') THEN
          ALTER TABLE "v2_canonical_events" ADD CONSTRAINT "chk_v2_canonical_log_nonneg" CHECK ("logIndex" >= 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_canonical_block_nonneg') THEN
          ALTER TABLE "v2_canonical_events" ADD CONSTRAINT "chk_v2_canonical_block_nonneg" CHECK ("blockNumber" >= 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_canonical_tx_len') THEN
          ALTER TABLE "v2_canonical_events" ADD CONSTRAINT "chk_v2_canonical_tx_len" CHECK (length("txHash") = 66);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_checkpoint_final_lte_safe') THEN
          ALTER TABLE "v2_event_checkpoints" ADD CONSTRAINT "chk_v2_checkpoint_final_lte_safe" CHECK ("lastFinalizedBlock" <= "lastSafeBlock");
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_checkpoint_chain_positive') THEN
          ALTER TABLE "v2_event_checkpoints" ADD CONSTRAINT "chk_v2_checkpoint_chain_positive" CHECK ("chainId" > 0);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_quarantine_reason') THEN
          ALTER TABLE "v2_event_quarantine" ADD CONSTRAINT "chk_v2_quarantine_reason" CHECK ("reason" IN ('unregistered_address','unknown_signature','artifact_drift','decode_error'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_cursor_log_gte_neg1') THEN
          ALTER TABLE "v2_projector_cursors" ADD CONSTRAINT "chk_v2_cursor_log_gte_neg1" CHECK ("lastLogIndex" >= -1);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_cursor_block_nonneg') THEN
          ALTER TABLE "v2_projector_cursors" ADD CONSTRAINT "chk_v2_cursor_block_nonneg" CHECK ("lastBlockNumber" >= 0);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_evidence_status') THEN
          ALTER TABLE "v2_project_evidence" ADD CONSTRAINT "chk_v2_evidence_status" CHECK ("status" IN ('active','removed'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_evidence_version_positive') THEN
          ALTER TABLE "v2_project_evidence" ADD CONSTRAINT "chk_v2_evidence_version_positive" CHECK ("currentVersion" > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_evidence_v_version_positive') THEN
          ALTER TABLE "v2_project_evidence_version" ADD CONSTRAINT "chk_v2_evidence_v_version_positive" CHECK ("version" > 0);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_round_type') THEN
          ALTER TABLE "v2_project_verification_round" ADD CONSTRAINT "chk_v2_round_type" CHECK ("roundType" IN ('first','appeal'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_round_status') THEN
          ALTER TABLE "v2_project_verification_round" ADD CONSTRAINT "chk_v2_round_status" CHECK ("status" IN ('open','closed','resolved'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_round_data_state') THEN
          ALTER TABLE "v2_project_verification_round" ADD CONSTRAINT "chk_v2_round_data_state" CHECK ("dataState" IN ('observed','safe','finalized'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_round_number_positive') THEN
          ALTER TABLE "v2_project_verification_round" ADD CONSTRAINT "chk_v2_round_number_positive" CHECK ("roundNumber" > 0);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_position_data_state') THEN
          ALTER TABLE "v2_project_participant_position" ADD CONSTRAINT "chk_v2_position_data_state" CHECK ("dataState" IN ('observed','safe','finalized'));
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_dispute_status') THEN
          ALTER TABLE "v2_project_dispute" ADD CONSTRAINT "chk_v2_dispute_status" CHECK ("status" IN ('raised','resolved','expired'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_dispute_data_state') THEN
          ALTER TABLE "v2_project_dispute" ADD CONSTRAINT "chk_v2_dispute_data_state" CHECK ("dataState" IN ('observed','safe','finalized'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_dispute_canonical_id') THEN
          ALTER TABLE "v2_project_dispute" ADD CONSTRAINT "chk_v2_dispute_canonical_id" CHECK ("disputeId" LIKE '%:%');
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_v2_anomaly_kind') THEN
          ALTER TABLE "v2_indexing_anomalies" ADD CONSTRAINT "chk_v2_anomaly_kind" CHECK ("kind" IN ('duplicate_event','out_of_order','invalid_transition'));
        END IF;
      END $$;
    `);

    // 4. Foreign keys (parent-checked paths only; see class doc for dispute omission).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_v2_evidence_version_evidence') THEN
          ALTER TABLE "v2_project_evidence_version"
          ADD CONSTRAINT "fk_v2_evidence_version_evidence" FOREIGN KEY ("evidenceId")
          REFERENCES "v2_project_evidence" ("evidenceId") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_v2_position_round') THEN
          ALTER TABLE "v2_project_participant_position"
          ADD CONSTRAINT "fk_v2_position_round" FOREIGN KEY ("roundId")
          REFERENCES "v2_project_verification_round" ("roundId") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$;
    `);

    // 5. Immutable-final-state triggers (fail closed at DB boundary).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "fn_v2_reject_dispute_terminal_mutation"()
      RETURNS trigger AS $fn$
      BEGIN
        IF OLD."status" IN ('resolved','expired') AND NEW."status" <> OLD."status" THEN
          RAISE EXCEPTION 'v2_project_dispute % is terminal (%) and immutable', OLD."disputeId", OLD."status";
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_v2_dispute_immutable_terminal" ON "v2_project_dispute";
      CREATE TRIGGER "trg_v2_dispute_immutable_terminal"
      BEFORE UPDATE ON "v2_project_dispute"
      FOR EACH ROW EXECUTE FUNCTION "fn_v2_reject_dispute_terminal_mutation"();
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "fn_v2_reject_round_terminal_mutation"()
      RETURNS trigger AS $fn$
      BEGIN
        IF OLD."status" IN ('closed','resolved') AND NEW."status" <> OLD."status" THEN
          RAISE EXCEPTION 'v2_project_verification_round % is terminal (%) and immutable', OLD."roundId", OLD."status";
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_v2_round_immutable_terminal" ON "v2_project_verification_round";
      CREATE TRIGGER "trg_v2_round_immutable_terminal"
      BEFORE UPDATE ON "v2_project_verification_round"
      FOR EACH ROW EXECUTE FUNCTION "fn_v2_reject_round_terminal_mutation"();
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "fn_v2_reject_evidence_version_mutation"()
      RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'v2_project_evidence_version is append-only: UPDATE/DELETE rejected';
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_v2_evidence_version_immutable" ON "v2_project_evidence_version";
      CREATE TRIGGER "trg_v2_evidence_version_immutable"
      BEFORE UPDATE OR DELETE ON "v2_project_evidence_version"
      FOR EACH ROW EXECUTE FUNCTION "fn_v2_reject_evidence_version_mutation"();
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_v2_project_dispute_original_round"
      ON "v2_project_dispute" ("originalRoundId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_v2_evidence_version_immutable" ON "v2_project_evidence_version"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "fn_v2_reject_evidence_version_mutation"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_v2_round_immutable_terminal" ON "v2_project_verification_round"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "fn_v2_reject_round_terminal_mutation"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_v2_dispute_immutable_terminal" ON "v2_project_dispute"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "fn_v2_reject_dispute_terminal_mutation"()`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_project_dispute_original_round"`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_v2_position_round') THEN
          ALTER TABLE "v2_project_participant_position" DROP CONSTRAINT "fk_v2_position_round";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_v2_evidence_version_evidence') THEN
          ALTER TABLE "v2_project_evidence_version" DROP CONSTRAINT "fk_v2_evidence_version_evidence";
        END IF;
      END $$;
    `);
    // CHECK/UNIQUE constraints and repaired columns are left in place on
    // downgrade to avoid data loss; triggers + FKs above are the reversible
    // protection layer.
  }
}
