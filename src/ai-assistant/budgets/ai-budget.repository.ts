import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { AiUsageEndpoint, AiUsageLog, AiUsageStatus } from '../entities/ai-usage-log.entity';
import { AiBudgetError } from './ai-budget.errors';
import { getBudgetWindow } from './ai-budget-policy';
import {
  AiBudgetOutcome, AiBudgetPrice, AiBudgetRequest, AiBudgetRule,
  AiBudgetState, AiBudgetUserWindow, AiBudgetWindow,
} from './ai-budget.types';

export interface StoredBudgetAttempt extends AiBudgetRequest {
  readonly id: string;
  readonly priceId: string;
  readonly policyId: string;
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
  readonly reservedTokens: string;
  readonly reservedNanos: string;
  readonly chargedTokens: string;
  readonly chargedNanos: string;
  readonly actualInputTokens: string | null;
  readonly actualOutputTokens: string | null;
  readonly state: AiBudgetState;
  readonly outcome: AiBudgetOutcome | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}
export interface StoredBudgetSettlement {
  readonly state: AiBudgetState;
  readonly chargedTokens: string;
  readonly chargedNanos: string;
  readonly actualInputTokens: string | null;
  readonly actualOutputTokens: string | null;
  readonly outcome: AiBudgetOutcome;
}
export interface BudgetConsumption {
  readonly tokens: string;
  readonly spendNanos: string;
  readonly unknownRequests: number;
}
interface WindowTotals extends BudgetConsumption {
  readonly actualTokens: string;
  readonly uncertainRequests: number;
}
const PRICE_COLUMNS = `id, provider, model, input_nanos::text AS "inputNanos",
  output_nanos::text AS "outputNanos", cached_input_nanos::text AS "cachedInputNanos"`;

/** Every query uses the already locked, caller-owned transaction manager. */
export class AiBudgetRepository {
  constructor(private readonly manager: EntityManager) {}

  async getPolicy(id: string): Promise<readonly AiBudgetRule[] | null> {
    const rows = await this.manager.query('SELECT rules FROM ai_budget_policies WHERE id=$1', [id]);
    return rows[0]?.rules ?? null;
  }

  async getPrice(provider: string, model: string): Promise<AiBudgetPrice | null> {
    const rows = await this.manager.query(
      `SELECT ${PRICE_COLUMNS} FROM ai_budget_prices
       WHERE provider=$1 AND model=$2 ORDER BY revision DESC LIMIT 1`, [provider, model]);
    return rows[0] ?? null;
  }

  async getAttemptPrice(id: string): Promise<AiBudgetPrice | null> {
    const rows = await this.manager.query(
      `SELECT ${PRICE_COLUMNS} FROM ai_budget_prices WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }

  async getOverride(
    userId: string, window: AiBudgetWindow, now: Date,
  ): Promise<Readonly<{ tokens: string; spendNanos: string }>> {
    const { start } = getBudgetWindow(window, now);
    const rows = await this.manager.query(
      `SELECT extra_tokens::text AS tokens, extra_nanos::text AS "spendNanos"
       FROM ai_budget_overrides WHERE user_id=$1 AND "window"=$2 AND window_start=$3
       AND revoked_at IS NULL AND expires_at>$4 AND created_at<=$4 LIMIT 2`,
      [userId, window, start, now]);
    if (rows.length > 1) throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    return rows[0] ?? { tokens: '0', spendNanos: '0' };
  }

  async getConsumption(rule: AiBudgetRule, request: AiBudgetRequest, now: Date): Promise<BudgetConsumption> {
    return this.windowTotals(rule.scope,
      rule.scope === 'user' ? request.userId : request.provider, rule.window, now);
  }

  async getUserWindow(userId: string, window: AiBudgetWindow, now: Date): Promise<AiBudgetUserWindow> {
    const bounds = getBudgetWindow(window, now);
    const totals = await this.windowTotals('user', userId, window, now);
    return Object.freeze({
      window, startAt: bounds.start.toISOString(), resetAt: bounds.end.toISOString(),
      actualTokens: totals.actualTokens, chargedTokens: totals.tokens,
      chargedSpendUsdNanos: totals.unknownRequests > 0 ? null : totals.spendNanos,
      uncertainRequests: totals.uncertainRequests,
    });
  }

  private scopeFilter(scope: AiBudgetRule['scope'], subject: string) {
    if (scope === 'user') return {
      attempts: 'AND user_id=$3', logs: 'AND "userId"=$3', parameters: [subject],
    };
    if (scope === 'provider') return {
      attempts: 'AND provider=$3', logs: 'AND provider=$3', parameters: [subject],
    };
    return { attempts: '', logs: '', parameters: [] };
  }

  private async windowTotals(
    scope: AiBudgetRule['scope'], subject: string, window: AiBudgetWindow, now: Date,
  ): Promise<WindowTotals> {
    const { start, end } = getBudgetWindow(window, now);
    const filter = this.scopeFilter(scope, subject);
    // Unknown legacy rows have an independent sentinel: an aggregate NULL never
    // becomes a fresh allowance. Linked logs are excluded to avoid double charging.
    const rows = await this.manager.query(`
      WITH charges AS (
        SELECT charged_tokens::numeric AS tokens, charged_nanos::numeric AS spend,
          (COALESCE(actual_input_tokens,0)::numeric +
           COALESCE(actual_output_tokens,0)::numeric) AS actual,
          CASE WHEN state='settled' THEN 0 ELSE 1 END AS uncertain_usage, 0 AS unknown_usage
        FROM ai_budget_attempts WHERE created_at>=$1 AND created_at<$2 ${filter.attempts}
        UNION ALL
        SELECT COALESCE("chargedTokens","totalTokens")::numeric AS tokens,
          "costUsdNanos"::numeric AS spend, "totalTokens"::numeric AS actual,
          CASE WHEN NOT "usageComplete" OR "totalTokens" IS NULL THEN 1 ELSE 0 END AS uncertain_usage,
          CASE WHEN "costUsdNanos" IS NULL OR "priceVersion" IS NULL OR
            ("chargedTokens" IS NULL AND "totalTokens" IS NULL) OR NOT "usageComplete"
            THEN 1 ELSE 0 END AS unknown_usage
        FROM ai_usage_logs WHERE "budgetAttemptId" IS NULL
          AND provider IN ('openai','anthropic') AND "createdAt">=$1 AND "createdAt"<$2 ${filter.logs}
      ) SELECT COALESCE(SUM(tokens),0)::text AS tokens,
        COALESCE(SUM(spend),0)::text AS "spendNanos",
        COALESCE(SUM(actual),0)::text AS "actualTokens",
        COALESCE(SUM(unknown_usage),0)::int AS "unknownRequests",
        COALESCE(SUM(uncertain_usage),0)::int AS "uncertainRequests" FROM charges`,
    [start, end, ...filter.parameters]);
    return rows[0];
  }

  async insertAttempt(attempt: StoredBudgetAttempt): Promise<void> {
    await this.manager.query(`INSERT INTO ai_budget_attempts
      (id,user_id,provider,model,operation,price_id,policy_id,max_input_tokens,max_output_tokens,
       reserved_tokens,reserved_nanos,charged_tokens,charged_nanos,state,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'held',$14)`,
    [attempt.id, attempt.userId, attempt.provider, attempt.model, attempt.operation,
      attempt.priceId, attempt.policyId, attempt.maxInputTokens, attempt.maxOutputTokens,
      attempt.reservedTokens, attempt.reservedNanos, attempt.chargedTokens, attempt.chargedNanos,
      attempt.createdAt]);
  }

  async getAttempt(id: string): Promise<StoredBudgetAttempt | null> {
    const rows = await this.manager.query(`SELECT id, user_id AS "userId", provider, model, operation,
      price_id AS "priceId", policy_id AS "policyId", max_input_tokens::text AS "maxInputTokens",
      max_output_tokens::text AS "maxOutputTokens", reserved_tokens::text AS "reservedTokens",
      reserved_nanos::text AS "reservedNanos", charged_tokens::text AS "chargedTokens",
      charged_nanos::text AS "chargedNanos", actual_input_tokens::text AS "actualInputTokens",
      actual_output_tokens::text AS "actualOutputTokens", state, outcome,
      created_at AS "createdAt", settled_at AS "settledAt"
      FROM ai_budget_attempts WHERE id=$1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  async settleAttempt(id: string, settlement: StoredBudgetSettlement, now: Date): Promise<void> {
    await this.manager.query(`UPDATE ai_budget_attempts SET state=$2, charged_tokens=$3, charged_nanos=$4,
      actual_input_tokens=$5, actual_output_tokens=$6, outcome=$7,
      settled_at=CASE WHEN $2='held' THEN NULL ELSE $8::timestamptz END
      WHERE id=$1 AND outcome IS NULL`,
    [id, settlement.state, settlement.chargedTokens, settlement.chargedNanos,
      settlement.actualInputTokens, settlement.actualOutputTokens, settlement.outcome, now]);
  }

  async writeUsage(
    attempt: StoredBudgetAttempt, settlement: StoredBudgetSettlement,
    outcome: AiBudgetOutcome, latencyMs: number, _now: Date,
  ): Promise<void> {
    const complete = settlement.actualInputTokens !== null && settlement.actualOutputTokens !== null;
    const totalTokens = complete ? (BigInt(settlement.actualInputTokens!) +
      BigInt(settlement.actualOutputTokens!)).toString() : null;
    await this.manager.getRepository(AiUsageLog).insert({
      id: randomUUID(), userId: attempt.userId, provider: attempt.provider, model: attempt.model,
      endpoint: attempt.operation === 'embedding' ? AiUsageEndpoint.KNOWLEDGE_BASE : AiUsageEndpoint.CHAT,
      status: outcome === 'success' && settlement.state !== 'violated' ?
        AiUsageStatus.SUCCESS : AiUsageStatus.ERROR,
      promptTokens: settlement.actualInputTokens, completionTokens: settlement.actualOutputTokens,
      totalTokens, latencyMs, cacheHit: false,
      errorCode: settlement.state === 'violated' ? 'AI_BUDGET_USAGE_BOUND_VIOLATED' :
        complete ? null : outcome === 'provider_error' ? 'AI_PROVIDER_ERROR' : 'AI_USAGE_MISSING',
      createdAt: attempt.createdAt, budgetAttemptId: attempt.id,
      priceVersion: attempt.priceId, chargedTokens: settlement.chargedTokens,
      costUsdNanos: settlement.chargedNanos, usageComplete: complete,
    });
  }
}
