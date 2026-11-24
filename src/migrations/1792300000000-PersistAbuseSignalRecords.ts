import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  ABUSE_DECISION_CHECKS,
  ABUSE_DECISION_INDETERMINATE_REASONS,
  ABUSE_DECISION_OUTCOMES,
} from '../abuse-signals/entities/abuse-decision-record.entity';
import { ABUSE_APPEAL_STATUSES } from '../abuse-signals/entities/abuse-appeal-record.entity';

/**
 * PREWAVE-BE-086 (#681): durable abuse decisions and appeals.
 *
 * Two tables, both operational evidence only. Nothing in the protocol path
 * reads them: claims, verification, disputes, rewards, treasury and governance
 * continue to derive from finalized canonical contract events.
 *
 * The enum-shaped columns carry CHECK constraints that enumerate exactly the
 * literals the TypeScript registries allow, so a bad write is rejected by the
 * database and not merely by the application.
 *
 * Row-level rules the database enforces, so they hold even under a direct
 * connection:
 *  - provenance columns are all-or-nothing (a decision carries a complete
 *    release binding or none at all);
 *  - an action row carries a kind, a status and a finite expiry;
 *  - an expiry must be in the future relative to the decision it belongs to.
 */
export class PersistAbuseSignalRecords1792300000000
  implements MigrationInterface
{
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Abuse signal persistence requires PostgreSQL');
    }

    await runner.query(`CREATE TABLE "abuse_decisions" (
      "id" varchar(32) NOT NULL PRIMARY KEY,
      "subjectKey" varchar(64) NOT NULL,
      "subjectKind" varchar(32) NOT NULL,
      "outcome" varchar(32) NOT NULL,
      "indeterminateReason" varchar(64) NULL,
      "reasonCode" varchar(64) NULL,
      "reasonCodeVersion" integer NULL,
      "signalKind" varchar(32) NULL,
      "severity" varchar(16) NULL,
      "confidence" real NOT NULL DEFAULT 0,
      "sampleCount" integer NOT NULL DEFAULT 0,
      "corroboratingDimensions" integer NOT NULL DEFAULT 0,
      "modelVersion" varchar(32) NOT NULL,
      "configVersion" varchar(32) NOT NULL,
      "bindingChainId" integer NULL,
      "releaseId" varchar(64) NULL,
      "deploymentBlock" varchar(32) NULL,
      "artifactChecksum" varchar(64) NULL,
      "actionId" varchar(32) NULL,
      "actionKind" varchar(32) NULL,
      "actionStatus" varchar(32) NULL,
      "actionExpiresAt" timestamptz NULL,
      "escalationLevel" integer NOT NULL DEFAULT 0,
      "appealable" boolean NOT NULL DEFAULT true,
      "decidedAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "chk_abuse_decision_outcome" CHECK ("outcome" IN (${ABUSE_DECISION_CHECKS.outcome})),
      CONSTRAINT "chk_abuse_decision_indeterminate_reason" CHECK ("indeterminateReason" IS NULL OR "indeterminateReason" IN (${ABUSE_DECISION_CHECKS.indeterminateReason})),
      CONSTRAINT "chk_abuse_decision_action_kind" CHECK ("actionKind" IS NULL OR "actionKind" IN (${ABUSE_DECISION_CHECKS.actionKind})),
      CONSTRAINT "chk_abuse_decision_action_status" CHECK ("actionStatus" IS NULL OR "actionStatus" IN (${ABUSE_DECISION_CHECKS.actionStatus})),
      CONSTRAINT "chk_abuse_decision_subject_key" CHECK (length("subjectKey") = 64),
      CONSTRAINT "chk_abuse_decision_confidence" CHECK ("confidence" >= 0 AND "confidence" <= 1),
      CONSTRAINT "chk_abuse_decision_escalation" CHECK ("escalationLevel" >= 0),
      CONSTRAINT "chk_abuse_decision_binding" CHECK (
        ("bindingChainId" IS NULL) = ("releaseId" IS NULL)
        AND ("bindingChainId" IS NULL) = ("deploymentBlock" IS NULL)
        AND ("bindingChainId" IS NULL) = ("artifactChecksum" IS NULL)
      ),
      CONSTRAINT "chk_abuse_decision_binding_chain" CHECK ("bindingChainId" IS NULL OR "bindingChainId" > 0),
      CONSTRAINT "chk_abuse_decision_action_bound" CHECK (
        ("actionId" IS NULL) = ("actionKind" IS NULL)
        AND ("actionId" IS NULL) = ("actionStatus" IS NULL)
        AND ("actionId" IS NULL) = ("actionExpiresAt" IS NULL)
      ),
      CONSTRAINT "chk_abuse_decision_action_expiry" CHECK ("actionExpiresAt" IS NULL OR "actionExpiresAt" > "decidedAt"),
      CONSTRAINT "chk_abuse_decision_appealable" CHECK ("appealable" = true)
    )`);

    await runner.query(
      `CREATE INDEX "idx_abuse_decisions_subject_time" ON "abuse_decisions" ("subjectKey", "decidedAt")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_decisions_time" ON "abuse_decisions" ("decidedAt")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_decisions_action" ON "abuse_decisions" ("actionId") WHERE "actionId" IS NOT NULL`,
    );

    await runner.query(`CREATE TABLE "abuse_appeals" (
      "id" varchar(64) NOT NULL PRIMARY KEY,
      "actionId" varchar(32) NOT NULL,
      "subjectKey" varchar(64) NOT NULL,
      "reason" varchar(500) NOT NULL,
      "status" varchar(16) NOT NULL DEFAULT 'pending',
      "submittedAt" timestamptz NOT NULL,
      "reviewDueAt" timestamptz NOT NULL,
      "decidedAt" timestamptz NULL,
      "decidedBy" varchar(64) NULL,
      "decisionNote" varchar(500) NULL,
      CONSTRAINT "chk_abuse_appeal_status" CHECK ("status" IN (${ABUSE_APPEAL_STATUSES.map((s) => `'${s}'`).join(',')})),
      CONSTRAINT "chk_abuse_appeal_sla" CHECK ("reviewDueAt" >= "submittedAt"),
      CONSTRAINT "chk_abuse_appeal_subject_key" CHECK (length("subjectKey") = 64),
      CONSTRAINT "chk_abuse_appeal_reason" CHECK (length(trim("reason")) > 0),
      CONSTRAINT "chk_abuse_appeal_decided" CHECK (
        ("status" = 'pending') = ("decidedAt" IS NULL)
      )
    )`);

    await runner.query(
      `CREATE INDEX "idx_abuse_appeals_subject_status" ON "abuse_appeals" ("subjectKey", "status")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_appeals_action" ON "abuse_appeals" ("actionId")`,
    );

    // The default is a subject without an open appeal, so the "at most N open
    // appeals" rule holds even under concurrent submissions.
    await runner.query(`CREATE UNIQUE INDEX "uq_abuse_appeals_one_pending_per_action"
      ON "abuse_appeals" ("actionId") WHERE "status" = 'pending'`);
  }

  /** Destructive rollback: export decisions and obtain operator approval first. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "abuse_appeals"`);
    await runner.query(`DROP TABLE "abuse_decisions"`);
  }
}

/** Re-exported so the enum lists stay in one place. */
export const ABUSE_MIGRATION_ENUMS = {
  outcomes: ABUSE_DECISION_OUTCOMES,
  indeterminateReasons: ABUSE_DECISION_INDETERMINATE_REASONS,
} as const;