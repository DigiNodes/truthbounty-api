import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shared abuse signal store (PREWAVE-BE-111, #812).
 *
 * Creates tables for durable abuse signal windows and actions so multi-replica
 * deployments converge on the same detection and enforcement state.
 *
 * **Windows:** Per-subject aggregates for the current evaluation window, with
 * atomic counters and bounded JSONB collections. Multiple replicas fed the same
 * observations will produce identical window state.
 *
 * **Actions:** Bounded, appealable enforcement actions with mandatory expiry
 * and release binding provenance. Actions survive restarts and expired actions
 * stop enforcement deterministically.
 *
 * **Decisions:** Already handled by the existing abuse_decisions table; this
 * migration adds only windows and actions.
 */
export class CreateSharedAbuseSignalStore1793000000000
  implements MigrationInterface
{
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Shared abuse signal store requires PostgreSQL');
    }

    // Create abuse_signal_windows table
    await runner.query(`
      CREATE TABLE "abuse_signal_windows" (
        "id" varchar(128) NOT NULL PRIMARY KEY,
        "subjectKey" varchar(64) NOT NULL,
        "subjectKind" varchar(32) NOT NULL,
        "windowStart" bigint NOT NULL,
        "windowMs" integer NOT NULL,
        "expiresAt" bigint NOT NULL,
        "total" integer NOT NULL DEFAULT 0,
        "reads" integer NOT NULL DEFAULT 0,
        "writes" integer NOT NULL DEFAULT 0,
        "authFailures" integer NOT NULL DEFAULT 0,
        "authSuccesses" integer NOT NULL DEFAULT 0,
        "webhookEndpointWrites" integer NOT NULL DEFAULT 0,
        "webhookSecretRotations" integer NOT NULL DEFAULT 0,
        "webhookDeliveries" integer NOT NULL DEFAULT 0,
        "streamConnect" integer NOT NULL DEFAULT 0,
        "streamDisconnect" integer NOT NULL DEFAULT 0,
        "streamSubscribeOps" integer NOT NULL DEFAULT 0,
        "streamMessages" integer NOT NULL DEFAULT 0,
        "supportRequests" integer NOT NULL DEFAULT 0,
        "supportDuplicateRequests" integer NOT NULL DEFAULT 0,
        "distinctRoutes" jsonb NOT NULL DEFAULT '[]',
        "routeSaturationHit" boolean NOT NULL DEFAULT false,
        "distinctCredentials" jsonb NOT NULL DEFAULT '[]',
        "credentialSaturationHit" boolean NOT NULL DEFAULT false,
        "supportContacts" jsonb NOT NULL DEFAULT '[]',
        "supportContactSaturationHit" boolean NOT NULL DEFAULT false,
        "duplicatePayloadCounts" jsonb NOT NULL DEFAULT '{}',
        "duplicatePayloadOverflow" integer NOT NULL DEFAULT 0,
        "supportDuplicateCounts" jsonb NOT NULL DEFAULT '{}',
        "subjectsPerCredential" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_abuse_window_subject_kind" CHECK ("subjectKind" IN ('principal','wallet','network_prefix')),
        CONSTRAINT "chk_abuse_window_boundaries" CHECK ("windowMs" > 0 AND "windowStart" >= 0),
        CONSTRAINT "chk_abuse_window_expiry" CHECK ("expiresAt" > "windowStart"),
        CONSTRAINT "chk_abuse_window_counters" CHECK (
          "total" >= 0 
          AND "reads" >= 0 
          AND "writes" >= 0 
          AND "authFailures" >= 0 
          AND "authSuccesses" >= 0
          AND "webhookEndpointWrites" >= 0
          AND "webhookSecretRotations" >= 0
          AND "webhookDeliveries" >= 0
          AND "streamConnect" >= 0
          AND "streamDisconnect" >= 0
          AND "streamSubscribeOps" >= 0
          AND "streamMessages" >= 0
          AND "supportRequests" >= 0
          AND "supportDuplicateRequests" >= 0
          AND "duplicatePayloadOverflow" >= 0
        )
      )
    `);

    await runner.query(
      `CREATE UNIQUE INDEX "idx_abuse_window_subject_start" ON "abuse_signal_windows" ("subjectKey", "windowStart")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_window_start" ON "abuse_signal_windows" ("windowStart")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_window_expiry" ON "abuse_signal_windows" ("expiresAt")`,
    );

    // Create abuse_actions table
    await runner.query(`
      CREATE TABLE "abuse_actions" (
        "id" varchar(32) NOT NULL PRIMARY KEY,
        "subjectKey" varchar(64) NOT NULL,
        "subjectKind" varchar(32) NOT NULL,
        "kind" varchar(32) NOT NULL,
        "status" varchar(32) NOT NULL,
        "reasonCode" varchar(64) NOT NULL,
        "reasonCodeVersion" integer NOT NULL,
        "modelVersion" varchar(32) NOT NULL,
        "configVersion" varchar(32) NOT NULL,
        "bindingChainId" integer NOT NULL,
        "releaseId" varchar(64) NOT NULL,
        "deploymentBlock" varchar(32) NOT NULL,
        "artifactChecksum" varchar(64) NOT NULL,
        "costMultiplier" real NOT NULL DEFAULT 1.0,
        "startedAt" timestamptz NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "appealable" boolean NOT NULL DEFAULT true,
        "escalationLevel" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_abuse_action_kind" CHECK ("kind" IN ('none','observe','throttle','challenge','suspend')),
        CONSTRAINT "chk_abuse_action_status" CHECK ("status" IN ('active','expired','lifted','superseded')),
        CONSTRAINT "chk_abuse_action_expiry" CHECK ("expiresAt" > "startedAt"),
        CONSTRAINT "chk_abuse_action_cost_multiplier" CHECK ("costMultiplier" >= 1.0 AND "costMultiplier" <= 1000.0),
        CONSTRAINT "chk_abuse_action_escalation" CHECK ("escalationLevel" >= 0 AND "escalationLevel" <= 10),
        CONSTRAINT "chk_abuse_action_reason_code_version" CHECK ("reasonCodeVersion" > 0),
        CONSTRAINT "chk_abuse_action_appealable" CHECK ("appealable" = true),
        CONSTRAINT "chk_abuse_action_binding" CHECK (("bindingChainId" IS NOT NULL) = ("artifactChecksum" IS NOT NULL))
      )
    `);

    await runner.query(
      `CREATE INDEX "idx_abuse_action_subject_started" ON "abuse_actions" ("subjectKey", "startedAt")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_action_expiry" ON "abuse_actions" ("expiresAt")`,
    );
    await runner.query(
      `CREATE INDEX "idx_abuse_action_status" ON "abuse_actions" ("status")`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS "abuse_actions"`);
    await runner.query(`DROP TABLE IF EXISTS "abuse_signal_windows"`);
  }
}
