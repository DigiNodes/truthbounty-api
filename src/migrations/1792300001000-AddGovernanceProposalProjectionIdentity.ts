import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-192 (#893): projection identity for ProposalCreated.
 *
 * A committed action set is now tied to the exact canonical event that
 * produced it. `lastEvent*` keeps tracking the latest lifecycle event, so it
 * cannot answer "was this ProposalCreated fully applied?" on its own.
 */
export class AddGovernanceProposalProjectionIdentity1792300001000
  implements MigrationInterface
{
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Governance projection identity requires PostgreSQL');
    }

    await runner.query(
      'ALTER TABLE "v2_governance_proposals" ADD COLUMN IF NOT EXISTS "createdEventTxHash" varchar(66)',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_proposals" ADD COLUMN IF NOT EXISTS "createdEventLogIndex" integer',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_proposals" ADD COLUMN IF NOT EXISTS "actionCount" integer NOT NULL DEFAULT 0',
    );

    // The old unique constraint referenced a `logIndex` column that does not
    // exist on the action table; one action per (proposal, index) is the
    // invariant the atomic projector needs.
    await runner.query(
      'ALTER TABLE "v2_governance_actions" DROP CONSTRAINT IF EXISTS "uq_v2_gov_action_prop_log"',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_actions" ADD CONSTRAINT "uq_v2_gov_action_prop_index" UNIQUE ("chainId", "proposalId", "actionIndex")',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE "v2_governance_actions" DROP CONSTRAINT IF EXISTS "uq_v2_gov_action_prop_index"',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_proposals" DROP COLUMN IF EXISTS "actionCount"',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_proposals" DROP COLUMN IF EXISTS "createdEventLogIndex"',
    );
    await runner.query(
      'ALTER TABLE "v2_governance_proposals" DROP COLUMN IF EXISTS "createdEventTxHash"',
    );
  }
}
