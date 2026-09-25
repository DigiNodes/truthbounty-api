import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-017: reward allocation / claim read model tables.
 *
 * Both tables are pure projections of canonical contract events. Amounts are
 * `varchar(100)` decimal strings — never `float`, never `double`, never a
 * `numeric` column the driver would hand back as a JS number. That matches the
 * convention already used by `v2_project_participant_position.stake` and
 * `v2_canonical_events.amount`, and it is what keeps a 256-bit `uint256` exact.
 */
export class CreateV2RewardAllocationTables1788100000000
  implements MigrationInterface
{
  name = 'CreateV2RewardAllocationTables1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_project_reward_pool" (
        "poolId" varchar(200) PRIMARY KEY,
        "chainId" integer NOT NULL,
        "claimId" varchar(66) NOT NULL,
        "asset" varchar(42) NOT NULL,
        "poolAmount" varchar(100) NOT NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_reward_pool_event" UNIQUE ("eventTxHash", "eventLogIndex")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_pool_claim_id" ON "v2_project_reward_pool" ("claimId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_pool_chain_id" ON "v2_project_reward_pool" ("chainId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "v2_project_reward_allocation" (
        "allocationId" varchar(200) PRIMARY KEY,
        "chainId" integer NOT NULL,
        "claimId" varchar(66) NOT NULL,
        "roundId" varchar(66) NULL,
        "sourcePoolId" varchar(200) NOT NULL,
        "kind" varchar(16) NOT NULL,
        "beneficiary" varchar(42) NULL,
        "asset" varchar(42) NOT NULL,
        "allocatedAmount" varchar(100) NOT NULL,
        "claimedAmount" varchar(100) NOT NULL DEFAULT '0',
        "lastClaimBlockNumber" bigint NULL,
        "lastClaimEvent" varchar(140) NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_allocation_claim_id" ON "v2_project_reward_allocation" ("claimId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_allocation_source_pool" ON "v2_project_reward_allocation" ("sourcePoolId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_allocation_beneficiary" ON "v2_project_reward_allocation" ("beneficiary")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_allocation_kind" ON "v2_project_reward_allocation" ("kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_allocation_chain_id" ON "v2_project_reward_allocation" ("chainId")`,
    );
    // Event-identity lookup, used by the projector's replay-vs-duplicate
    // discrimination. Mirrors the equivalent unique constraint on the other V2
    // read models so a replayed event is always idempotent rather than
    // ambiguous.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_v2_reward_allocation_event" ON "v2_project_reward_allocation" ("eventTxHash", "eventLogIndex")`,
    );

    // One row per emitted RewardClaimed event. This is the idempotency guard for
    // the allocation's `claimedAmount` counter: without a row keyed on the
    // emitting event, replaying a claim would double-count it.
    await queryRunner.query(`
      CREATE TABLE "v2_project_reward_claim" (
        "withdrawalId" varchar(200) PRIMARY KEY,
        "chainId" integer NOT NULL,
        "allocationId" varchar(200) NOT NULL,
        "claimId" varchar(66) NOT NULL,
        "beneficiary" varchar(42) NULL,
        "asset" varchar(42) NULL,
        "amount" varchar(100) NOT NULL,
        "claimTxHash" varchar(66) NOT NULL,
        "claimLogIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_reward_claim_event" UNIQUE ("chainId", "claimTxHash", "claimLogIndex")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_claim_allocation_id" ON "v2_project_reward_claim" ("allocationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_reward_claim_claim_id" ON "v2_project_reward_claim" ("claimId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_project_reward_claim"`);
    await queryRunner.query(`DROP TABLE "v2_project_reward_allocation"`);
    await queryRunner.query(`DROP TABLE "v2_project_reward_pool"`);
  }
}
