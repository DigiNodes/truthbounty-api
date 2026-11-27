import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-190 (#891): immutable canonical governance lifecycle history.
 *
 * The proposal row only keeps its current state, so the timelock endpoint
 * loses earlier lifecycle blocks after a subsequent transition. This table
 * stores one append-only row per canonical lifecycle event with full
 * on-chain provenance. Replay is idempotent via the identity unique index;
 * reorg rollback deletes only rows above the affected block.
 */
export class CreateV2GovernanceProposalTransitions1792600000000
  implements MigrationInterface
{
  name = 'CreateV2GovernanceProposalTransitions1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const uuid = isPostgres
      ? 'uuid NOT NULL DEFAULT gen_random_uuid()'
      : 'varchar(36) NOT NULL';
    const timestamp = isPostgres ? 'timestamptz' : 'datetime';

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "v2_governance_proposal_transitions" (
        "id" ${uuid},
        "chainId" integer NOT NULL,
        "contractAddress" varchar(42) NOT NULL,
        "proposalId" bigint NOT NULL,
        "eventName" varchar(128) NOT NULL,
        "state" varchar(32) NOT NULL DEFAULT 'PENDING',
        "eta" bigint NULL,
        "txHash" varchar(66) NOT NULL,
        "logIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "blockTimestamp" ${timestamp} NULL,
        "artifactVersion" varchar(64) NOT NULL,
        "recordedAt" ${timestamp} NOT NULL DEFAULT ${isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'},
        CONSTRAINT "PK_v2_gov_transition_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_v2_gov_transition_identity" UNIQUE ("chainId", "txHash", "logIndex"),
        CONSTRAINT "chk_v2_gov_transition_chain_positive" CHECK ("chainId" > 0),
        CONSTRAINT "chk_v2_gov_transition_log_nonneg" CHECK ("logIndex" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_v2_gov_transition_proposal"
      ON "v2_governance_proposal_transitions" ("chainId", "proposalId", "blockNumber", "logIndex")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_v2_gov_transition_proposal_event"
      ON "v2_governance_proposal_transitions" ("chainId", "proposalId", "eventName")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "v2_governance_proposal_transitions"`,
    );
  }
}
