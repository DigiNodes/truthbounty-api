import { MigrationInterface, QueryRunner } from 'typeorm';

export class OptimizeClaimIndexes1769500000000 implements MigrationInterface {
  name = 'OptimizeClaimIndexes1769500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add indexes for claims table to optimize queries
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_finalized" ON "claims" ("finalized")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_confidence_score" ON "claims" ("confidenceScore") WHERE "confidenceScore" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_claims_resolved_verdict" ON "claims" ("resolvedVerdict") WHERE "resolvedVerdict" IS NOT NULL`,
    );

    // Add indexes for stake table to optimize claim-related queries
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_claim_id" ON "stake" ("claimId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_wallet_address" ON "stake" ("walletAddress")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_updated_at" ON "stake" ("updatedAt")`,
    );

    // Add indexes for stake_event table
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_event_claim_id" ON "stake_event" ("claimId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_event_wallet_address" ON "stake_event" ("walletAddress")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_event_timestamp" ON "stake_event" ("timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_event_block_number" ON "stake_event" ("blockNumber")`,
    );

    // Add composite index for common query patterns
    await queryRunner.query(
      `CREATE INDEX "IDX_stake_event_claim_wallet" ON "stake_event" ("claimId", "walletAddress")`,
    );

    // Add indexes for disputes table to optimize claim lookups
    await queryRunner.query(
      `CREATE INDEX "IDX_disputes_claim_id" ON "disputes" ("claimId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_disputes_status" ON "disputes" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_disputes_created_at" ON "disputes" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_disputes_claim_status" ON "disputes" ("claimId", "status")`,
    );

    // Add indexes for reward_claims to optimize leaderboard queries
    await queryRunner.query(
      `CREATE INDEX "IDX_reward_claims_wallet_timestamp" ON "reward_claims" ("walletAddress", "blockTimestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reward_claims_amount" ON "reward_claims" ("amount")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop reward_claims indexes
    await queryRunner.query(`DROP INDEX "public"."IDX_reward_claims_amount"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_reward_claims_wallet_timestamp"`,
    );

    // Drop disputes indexes
    await queryRunner.query(`DROP INDEX "public"."IDX_disputes_claim_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_disputes_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_disputes_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_disputes_claim_id"`);

    // Drop stake_event indexes
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stake_event_claim_wallet"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stake_event_block_number"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_stake_event_timestamp"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stake_event_wallet_address"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_stake_event_claim_id"`);

    // Drop stake indexes
    await queryRunner.query(`DROP INDEX "public"."IDX_stake_updated_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_stake_wallet_address"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_stake_claim_id"`);

    // Drop claims indexes
    await queryRunner.query(
      `DROP INDEX "public"."IDX_claims_resolved_verdict"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_claims_confidence_score"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_claims_finalized"`);
  }
}
