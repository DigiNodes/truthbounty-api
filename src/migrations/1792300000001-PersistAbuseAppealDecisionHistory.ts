import { MigrationInterface, QueryRunner } from 'typeorm';

/** PREWAVE-BE-105: append-only moderation decision history for appeals. */
export class PersistAbuseAppealDecisionHistory1792300000001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Abuse appeal history persistence requires PostgreSQL');
    }

    await runner.query(`CREATE TABLE "abuse_actions" (
      "id" varchar(32) NOT NULL PRIMARY KEY,
      "subjectKey" varchar(64) NOT NULL,
      "subjectKind" varchar(32) NOT NULL,
      "kind" varchar(16) NOT NULL,
      "status" varchar(16) NOT NULL,
      "reasonCode" varchar(64) NOT NULL,
      "reasonCodeVersion" integer NOT NULL,
      "modelVersion" varchar(32) NOT NULL,
      "configVersion" varchar(32) NOT NULL,
      "bindingChainId" integer NOT NULL,
      "releaseId" varchar(64) NOT NULL,
      "deploymentBlock" varchar(32) NOT NULL,
      "artifactChecksum" varchar(64) NOT NULL,
      "costMultiplier" real NOT NULL,
      "startedAt" timestamptz NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "appealable" boolean NOT NULL DEFAULT true,
      "escalationLevel" integer NOT NULL,
      CONSTRAINT "chk_abuse_action_status" CHECK ("status" IN ('active', 'expired', 'lifted', 'superseded')),
      CONSTRAINT "chk_abuse_action_expiry" CHECK ("expiresAt" > "startedAt"),
      CONSTRAINT "chk_abuse_action_binding" CHECK ("bindingChainId" > 0)
    )`);

    await runner.query(
      `CREATE INDEX "idx_abuse_actions_subject_status_expiry" ON "abuse_actions" ("subjectKey", "status", "expiresAt")`,
    );

    await runner.query(`CREATE TABLE "abuse_appeal_decision_history" (
      "id" varchar(36) NOT NULL PRIMARY KEY,
      "appealId" varchar(64) NOT NULL,
      "status" varchar(16) NOT NULL,
      "decidedAt" timestamptz NOT NULL,
      "decidedBy" varchar(64) NOT NULL,
      "decisionNote" varchar(500) NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "chk_abuse_appeal_history_status" CHECK ("status" IN ('approved', 'rejected', 'expired')),
      CONSTRAINT "fk_abuse_appeal_history_appeal" FOREIGN KEY ("appealId") REFERENCES "abuse_appeals"("id") ON DELETE RESTRICT
    )`);

    await runner.query(
      `CREATE INDEX "idx_abuse_appeal_history_appeal_time" ON "abuse_appeal_decision_history" ("appealId", "decidedAt")`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "abuse_appeal_decision_history"`);
    await runner.query(`DROP TABLE "abuse_actions"`);
  }
}
