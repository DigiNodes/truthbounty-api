import { MigrationInterface, QueryRunner } from 'typeorm';

const CHANGE_REFERENCE = "change_reference ~ '^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}$'";
const AMOUNT_MAX = '9000000000000000000';

export class DurableAiBudgets1795300000000 implements MigrationInterface {
  name = 'DurableAiBudgets1795300000000';

  async up(runner: QueryRunner): Promise<void> {
    this.postgres(runner);
    await this.atomic(runner, async () => {
      await this.usageFoundation(runner);
      await this.policiesAndPrices(runner);
      await this.authority(runner);
      await this.attempts(runner);
      await this.overrides(runner);
      await this.usageAccounting(runner);
      await this.immutability(runner);
    });
  }

  private postgres(runner: QueryRunner): void {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Durable AI budgets require PostgreSQL');
    }
  }

  private async atomic(runner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const ownsTransaction = !runner.isTransactionActive;
    if (ownsTransaction) await runner.startTransaction();
    try {
      await work();
      if (ownsTransaction) await runner.commitTransaction();
    } catch (error) {
      if (ownsTransaction && runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  /** The earlier SQLite DDL cannot provision a fresh PostgreSQL usage table. */
  private async usageFoundation(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS "ai_usage_logs" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" varchar NULL, "conversationId" varchar NULL, "messageId" varchar NULL,
      provider varchar NOT NULL, model varchar NULL, endpoint varchar NOT NULL,
      status varchar NOT NULL, "promptTokens" bigint NULL, "completionTokens" bigint NULL,
      "totalTokens" bigint NULL, "latencyMs" integer NOT NULL DEFAULT 0,
      "cacheHit" boolean NOT NULL DEFAULT FALSE, "errorCode" varchar NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    // Widen values, remove synthetic defaults and allow explicit unknowns; do
    // not rewrite rows, IDs, dates, legacy usage completeness, prices or costs.
    await runner.query(`ALTER TABLE "ai_usage_logs"
      ALTER COLUMN "userId" DROP NOT NULL,
      ALTER COLUMN "promptTokens" TYPE bigint USING "promptTokens"::bigint,
      ALTER COLUMN "promptTokens" DROP NOT NULL,
      ALTER COLUMN "promptTokens" DROP DEFAULT,
      ALTER COLUMN "completionTokens" TYPE bigint USING "completionTokens"::bigint,
      ALTER COLUMN "completionTokens" DROP NOT NULL,
      ALTER COLUMN "completionTokens" DROP DEFAULT,
      ALTER COLUMN "totalTokens" TYPE bigint USING "totalTokens"::bigint,
      ALTER COLUMN "totalTokens" DROP NOT NULL,
      ALTER COLUMN "totalTokens" DROP DEFAULT`);
  }

  private async policiesAndPrices(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "ai_budget_policies" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      rules jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_id varchar NOT NULL, change_reference varchar NOT NULL,
      CONSTRAINT chk_ai_budget_policy_rules CHECK (
        CASE WHEN jsonb_typeof(rules)='array' THEN jsonb_array_length(rules) BETWEEN 1 AND 32
        ELSE FALSE END),
      CONSTRAINT chk_ai_budget_policy_reference CHECK (${CHANGE_REFERENCE})
    )`);
    await runner.query(`CREATE TABLE "ai_budget_prices" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      provider varchar NOT NULL, model varchar NOT NULL,
      input_nanos bigint NOT NULL, output_nanos bigint NOT NULL, cached_input_nanos bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_id varchar NOT NULL, change_reference varchar NOT NULL,
      CONSTRAINT uq_ai_budget_price_model UNIQUE (id,provider,model),
      CONSTRAINT chk_ai_budget_price_input CHECK (input_nanos BETWEEN 1 AND 1000000000),
      CONSTRAINT chk_ai_budget_price_output CHECK (output_nanos BETWEEN 0 AND 1000000000),
      CONSTRAINT chk_ai_budget_price_cached CHECK (cached_input_nanos BETWEEN 0 AND input_nanos),
      CONSTRAINT chk_ai_budget_price_model CHECK (
        (provider='openai' AND model='gpt-4o-mini' AND output_nanos>0) OR
        (provider='anthropic' AND model='claude-3-haiku-20240307' AND output_nanos>0) OR
        (provider='openai' AND model='text-embedding-3-small' AND output_nanos=0)),
      CONSTRAINT chk_ai_budget_price_reference CHECK (${CHANGE_REFERENCE})
    )`);
    await runner.query(`CREATE INDEX idx_ai_budget_prices_model_revision
      ON "ai_budget_prices" (provider,model,revision DESC)`);
  }

  private async authority(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "ai_budget_authority" (
      id integer PRIMARY KEY CHECK (id=1),
      policy_version uuid NULL REFERENCES "ai_budget_policies" (id),
      coverage_start timestamptz NULL, halted boolean NOT NULL DEFAULT FALSE
    )`);
    // No default allowance and no assertion that legacy cross-store history is empty.
    await runner.query('INSERT INTO "ai_budget_authority" (id) VALUES (1)');
  }

  private async attempts(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "ai_budget_attempts" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL, provider varchar NOT NULL, model varchar NOT NULL,
      operation varchar NOT NULL, price_id uuid NOT NULL,
      policy_id uuid NOT NULL REFERENCES "ai_budget_policies" (id),
      max_input_tokens bigint NOT NULL, max_output_tokens bigint NOT NULL,
      reserved_tokens bigint NOT NULL, reserved_nanos bigint NOT NULL,
      charged_tokens bigint NOT NULL, charged_nanos bigint NOT NULL,
      actual_input_tokens bigint NULL, actual_output_tokens bigint NULL,
      state varchar NOT NULL DEFAULT 'held', outcome varchar NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz NULL,
      CONSTRAINT uq_ai_budget_attempt_price UNIQUE (id,price_id),
      CONSTRAINT fk_ai_budget_attempt_price FOREIGN KEY (price_id,provider,model)
        REFERENCES "ai_budget_prices" (id,provider,model),
      CONSTRAINT chk_ai_budget_attempt_bounds CHECK (
        (provider='openai' AND model='gpt-4o-mini' AND operation='chat'
          AND max_input_tokens=128000 AND max_output_tokens=16384) OR
        (provider='anthropic' AND model='claude-3-haiku-20240307' AND operation='chat'
          AND max_input_tokens=200000 AND max_output_tokens=1024) OR
        (provider='openai' AND model='text-embedding-3-small' AND operation='embedding'
          AND max_input_tokens=8192 AND max_output_tokens=0)),
      CONSTRAINT chk_ai_budget_attempt_amounts CHECK (
        reserved_tokens BETWEEN 1 AND ${AMOUNT_MAX} AND reserved_nanos BETWEEN 1 AND ${AMOUNT_MAX}
        AND charged_tokens BETWEEN 0 AND ${AMOUNT_MAX} AND charged_nanos BETWEEN 0 AND ${AMOUNT_MAX}
        AND reserved_tokens=max_input_tokens+max_output_tokens
        AND (actual_input_tokens IS NULL OR actual_input_tokens BETWEEN 0 AND ${AMOUNT_MAX})
        AND (actual_output_tokens IS NULL OR actual_output_tokens BETWEEN 0 AND ${AMOUNT_MAX})),
      CONSTRAINT chk_ai_budget_attempt_outcome CHECK (
        outcome IS NULL OR outcome IN ('success','provider_error','usage_missing')),
      CONSTRAINT chk_ai_budget_attempt_state CHECK (
        (state='held' AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL
          AND charged_tokens=reserved_tokens AND charged_nanos=reserved_nanos AND settled_at IS NULL) OR
        (state='settled' AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL
          AND actual_input_tokens<=max_input_tokens AND actual_output_tokens<=max_output_tokens
          AND charged_tokens=actual_input_tokens+actual_output_tokens AND charged_nanos<=reserved_nanos
          AND outcome IS NOT NULL AND settled_at IS NOT NULL) OR
        (state='violated' AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL
          AND (actual_input_tokens>max_input_tokens OR actual_output_tokens>max_output_tokens)
          AND charged_tokens>=reserved_tokens AND charged_nanos>=reserved_nanos
          AND outcome IS NOT NULL AND settled_at IS NOT NULL))
    )`);
    await runner.query('CREATE INDEX idx_ai_budget_attempt_user_time ON "ai_budget_attempts" (user_id,created_at)');
    await runner.query('CREATE INDEX idx_ai_budget_attempt_provider_time ON "ai_budget_attempts" (provider,created_at)');
    await runner.query('CREATE INDEX idx_ai_budget_attempt_time ON "ai_budget_attempts" (created_at)');
  }

  private async overrides(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "ai_budget_overrides" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar NOT NULL,
      "window" varchar NOT NULL CHECK ("window" IN ('day','month')),
      window_start timestamptz NOT NULL, extra_tokens bigint NOT NULL, extra_nanos bigint NOT NULL,
      expires_at timestamptz NOT NULL, revoked_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_id varchar NOT NULL, change_reference varchar NOT NULL,
      CONSTRAINT chk_ai_budget_override_amounts CHECK (
        extra_tokens BETWEEN 0 AND 1000000 AND extra_nanos BETWEEN 0 AND 100000000000
        AND (extra_tokens>0 OR extra_nanos>0)),
      CONSTRAINT chk_ai_budget_override_window CHECK (
        window_start=(date_trunc("window",window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),
      CONSTRAINT chk_ai_budget_override_expiry CHECK (
        expires_at>created_at AND expires_at<=created_at+INTERVAL '24 hours' AND
        expires_at<=(((window_start AT TIME ZONE 'UTC') +
          CASE WHEN "window"='day' THEN INTERVAL '1 day' ELSE INTERVAL '1 month' END) AT TIME ZONE 'UTC')),
      CONSTRAINT chk_ai_budget_override_revocation CHECK (revoked_at IS NULL OR revoked_at>=created_at),
      CONSTRAINT chk_ai_budget_override_reference CHECK (${CHANGE_REFERENCE})
    )`);
    // Expiry cannot be part of a clock-dependent partial unique index. Admission
    // and admin inserts both hold the singleton and check active expiry instead.
    await runner.query(`CREATE INDEX idx_ai_budget_override_window
      ON "ai_budget_overrides" (user_id,"window",window_start)`);
  }

  private async usageAccounting(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "ai_usage_logs"
      ADD COLUMN "budgetAttemptId" uuid NULL,
      ADD COLUMN "priceVersion" uuid NULL REFERENCES "ai_budget_prices" (id),
      ADD COLUMN "chargedTokens" bigint NULL,
      ADD COLUMN "costUsdNanos" bigint NULL,
      ADD COLUMN "usageComplete" boolean NOT NULL DEFAULT FALSE,
      ADD CONSTRAINT fk_ai_usage_attempt_price FOREIGN KEY ("budgetAttemptId","priceVersion")
        REFERENCES "ai_budget_attempts" (id,price_id),
      ADD CONSTRAINT chk_ai_usage_charges CHECK (
        ("chargedTokens" IS NULL OR "chargedTokens" BETWEEN 0 AND ${AMOUNT_MAX}) AND
        ("costUsdNanos" IS NULL OR "costUsdNanos" BETWEEN 0 AND ${AMOUNT_MAX})),
      ADD CONSTRAINT chk_ai_usage_budget_fields CHECK (
        "budgetAttemptId" IS NULL OR ("priceVersion" IS NOT NULL AND "chargedTokens" IS NOT NULL
          AND "costUsdNanos" IS NOT NULL AND
          (("usageComplete" AND "promptTokens" IS NOT NULL AND "completionTokens" IS NOT NULL
            AND "totalTokens" IS NOT NULL AND "promptTokens">=0 AND "completionTokens">=0
            AND "totalTokens"::numeric="promptTokens"::numeric+"completionTokens"::numeric) OR
           (NOT "usageComplete" AND "promptTokens" IS NULL
            AND "completionTokens" IS NULL AND "totalTokens" IS NULL))))
    `);
    await runner.query(`CREATE UNIQUE INDEX uq_ai_usage_budget_attempt
      ON "ai_usage_logs" ("budgetAttemptId")`);
    await runner.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_budget_user_time
      ON "ai_usage_logs" ("userId","createdAt")`);
    await runner.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_budget_provider_time
      ON "ai_usage_logs" (provider,"createdAt")`);
  }

  private async immutability(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION reject_ai_budget_evidence_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'AI budget revisions and usage records are append-only'; END;
    $$ LANGUAGE plpgsql`);
    for (const table of ['ai_budget_policies', 'ai_budget_prices', 'ai_usage_logs']) {
      await runner.query(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION reject_ai_budget_evidence_mutation()`);
      await runner.query(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON "${table}"
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ai_budget_evidence_mutation()`);
    }
    await this.authorityGuard(runner);
    await this.attemptGuard(runner);
    await this.overrideGuard(runner);
  }

  private async authorityGuard(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION guard_ai_budget_authority() RETURNS trigger AS $$
      BEGIN
        IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'AI budget authority is durable'; END IF;
        IF NEW.id<>OLD.id OR
          (OLD.coverage_start IS NOT NULL AND NEW.coverage_start IS DISTINCT FROM OLD.coverage_start) OR
          (OLD.halted AND NOT NEW.halted) THEN
          RAISE EXCEPTION 'AI budget coverage and halt cannot be reset';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE TRIGGER ai_budget_authority_guard BEFORE UPDATE OR DELETE ON "ai_budget_authority"
      FOR EACH ROW EXECUTE FUNCTION guard_ai_budget_authority()`);
    await runner.query(`CREATE TRIGGER ai_budget_authority_no_truncate BEFORE TRUNCATE ON "ai_budget_authority"
      FOR EACH STATEMENT EXECUTE FUNCTION guard_ai_budget_authority()`);
  }

  private async attemptGuard(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION guard_ai_budget_attempt() RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI budget attempts are durable'; END IF;
        IF ROW(NEW.id,NEW.user_id,NEW.provider,NEW.model,NEW.operation,NEW.price_id,NEW.policy_id,
          NEW.max_input_tokens,NEW.max_output_tokens,NEW.reserved_tokens,NEW.reserved_nanos,NEW.created_at)
          IS DISTINCT FROM
          ROW(OLD.id,OLD.user_id,OLD.provider,OLD.model,OLD.operation,OLD.price_id,OLD.policy_id,
          OLD.max_input_tokens,OLD.max_output_tokens,OLD.reserved_tokens,OLD.reserved_nanos,OLD.created_at)
          OR (OLD.outcome IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'AI budget admission and finalized evidence are immutable';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE TRIGGER ai_budget_attempt_guard BEFORE UPDATE OR DELETE ON "ai_budget_attempts"
      FOR EACH ROW EXECUTE FUNCTION guard_ai_budget_attempt()`);
    await runner.query(`CREATE TRIGGER ai_budget_attempt_no_truncate BEFORE TRUNCATE ON "ai_budget_attempts"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ai_budget_evidence_mutation()`);
  }

  private async overrideGuard(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION guard_ai_budget_override() RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI budget overrides are durable'; END IF;
        IF ROW(NEW.id,NEW.user_id,NEW."window",NEW.window_start,NEW.extra_tokens,NEW.extra_nanos,
          NEW.expires_at,NEW.created_at,NEW.actor_id,NEW.change_reference)
          IS DISTINCT FROM
          ROW(OLD.id,OLD.user_id,OLD."window",OLD.window_start,OLD.extra_tokens,OLD.extra_nanos,
          OLD.expires_at,OLD.created_at,OLD.actor_id,OLD.change_reference)
          OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
          RAISE EXCEPTION 'AI budget override evidence is immutable';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE TRIGGER ai_budget_override_guard BEFORE UPDATE OR DELETE ON "ai_budget_overrides"
      FOR EACH ROW EXECUTE FUNCTION guard_ai_budget_override()`);
    await runner.query(`CREATE TRIGGER ai_budget_override_no_truncate BEFORE TRUNCATE ON "ai_budget_overrides"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_ai_budget_evidence_mutation()`);
  }

  /** Refuse loss of durable ledger/configuration evidence, including a cutover marker. */
  async down(runner: QueryRunner): Promise<void> {
    this.postgres(runner);
    await this.atomic(runner, async () => {
      await runner.query(`LOCK TABLE "ai_budget_authority","ai_budget_attempts","ai_budget_policies",
        "ai_budget_prices","ai_budget_overrides","ai_usage_logs" IN ACCESS EXCLUSIVE MODE`);
      await this.refusePopulated(runner);
      await this.removeBudgetSchema(runner);
    });
  }

  private async refusePopulated(runner: QueryRunner): Promise<void> {
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "ai_budget_attempts") OR
        EXISTS (SELECT 1 FROM "ai_budget_policies") OR
        EXISTS (SELECT 1 FROM "ai_budget_prices") OR
        EXISTS (SELECT 1 FROM "ai_budget_overrides") OR
        EXISTS (SELECT 1 FROM "ai_budget_authority"
          WHERE policy_version IS NOT NULL OR coverage_start IS NOT NULL OR halted) OR
        EXISTS (SELECT 1 FROM "ai_usage_logs" WHERE "budgetAttemptId" IS NOT NULL OR
          "priceVersion" IS NOT NULL OR "chargedTokens" IS NOT NULL OR "costUsdNanos" IS NOT NULL
          OR "usageComplete") THEN
        RAISE EXCEPTION 'Refusing to remove populated AI budget evidence';
      END IF;
    END $$`);
  }

  private async removeBudgetSchema(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TRIGGER ai_usage_logs_immutable ON "ai_usage_logs"');
    await runner.query('DROP TRIGGER ai_usage_logs_no_truncate ON "ai_usage_logs"');
    await runner.query(`ALTER TABLE "ai_usage_logs"
      DROP COLUMN "budgetAttemptId", DROP COLUMN "priceVersion", DROP COLUMN "chargedTokens",
      DROP COLUMN "costUsdNanos", DROP COLUMN "usageComplete"`);
    for (const table of [
      'ai_budget_overrides', 'ai_budget_attempts', 'ai_budget_authority',
      'ai_budget_prices', 'ai_budget_policies',
    ]) await runner.query(`DROP TABLE "${table}"`);
    for (const name of [
      'guard_ai_budget_override', 'guard_ai_budget_attempt',
      'guard_ai_budget_authority', 'reject_ai_budget_evidence_mutation',
    ]) await runner.query(`DROP FUNCTION ${name}()`);
    // Keep the usage table and widened nullable actual columns. Re-narrowing or
    // reintroducing zero defaults would lose historical/unknown usage evidence.
  }
}
