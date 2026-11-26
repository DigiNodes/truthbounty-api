CREATE TABLE "analytics_consent_current" (
  "subject_key" varchar(64) NOT NULL PRIMARY KEY,
  "policy_version" varchar(64) NOT NULL,
  "status" varchar(16) NOT NULL,
  "granted_at" timestamptz NULL,
  "withdrawn_at" timestamptz NULL,
  "do_not_track" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_analytics_consent_subject_key"
    CHECK ("subject_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_analytics_consent_status"
    CHECK ("status" IN ('none', 'granted', 'withdrawn')),
  CONSTRAINT "chk_analytics_consent_policy"
    CHECK (length(trim("policy_version")) > 0),
  CONSTRAINT "chk_analytics_consent_timestamps"
    CHECK (
      ("status" = 'granted' AND "granted_at" IS NOT NULL AND "withdrawn_at" IS NULL)
      OR ("status" = 'withdrawn' AND "withdrawn_at" IS NOT NULL)
      OR ("status" = 'none' AND "granted_at" IS NULL AND "withdrawn_at" IS NULL)
    )
);

CREATE INDEX "idx_analytics_consent_status_updated"
  ON "analytics_consent_current" ("status", "updated_at");

CREATE TABLE "analytics_consent_history" (
  "id" uuid NOT NULL PRIMARY KEY,
  "event_type" varchar(32) NOT NULL,
  "subject_key" varchar(64) NULL,
  "related_subject_key" varchar(64) NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "retention_until" timestamptz NOT NULL,
  CONSTRAINT "chk_analytics_consent_history_event"
    CHECK (
      ("event_type" = 'subject_rotated'
        AND "subject_key" ~ '^[0-9a-f]{64}$'
        AND "related_subject_key" ~ '^[0-9a-f]{64}$'
        AND "subject_key" <> "related_subject_key")
      OR ("event_type" = 'subject_deleted'
        AND "subject_key" IS NULL
        AND "related_subject_key" IS NULL)
    ),
  CONSTRAINT "chk_analytics_consent_history_retention"
    CHECK ("retention_until" >= "occurred_at")
);

CREATE INDEX "idx_analytics_consent_history_subject"
  ON "analytics_consent_history" ("subject_key", "related_subject_key");
CREATE INDEX "idx_analytics_consent_history_retention"
  ON "analytics_consent_history" ("retention_until");
