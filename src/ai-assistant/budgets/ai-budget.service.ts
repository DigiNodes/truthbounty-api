import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AiBudgetError } from './ai-budget.errors';
import {
  applicableBudgetRules, assertBudgetCoverage, BUDGET_UUID, budgetAmount,
  getBudgetWindow, MAX_BUDGET_AMOUNT, validateBudgetPolicy, validateBudgetPrice,
} from './ai-budget-policy';
import { getProviderBound } from './ai-provider-bound';
import { AiBudgetRepository, StoredBudgetAttempt, StoredBudgetSettlement } from './ai-budget.repository';
import {
  AiBudgetAccounting, AiBudgetAuthority, AiBudgetOutcome, AiBudgetPort, AiBudgetPrice,
  AiBudgetRequest, AiBudgetReservation, AiBudgetRule, AiBudgetUsage, AiBudgetUserUsage,
  AiProviderBound,
} from './ai-budget.types';

interface RuleDecision {
  readonly tooLarge: boolean;
  readonly resetAt: Date | null;
}
type ReconcileResult =
  | { readonly accounting: AiBudgetAccounting; readonly failed: false }
  | { readonly accounting: null; readonly failed: true };
interface KnownUsage {
  readonly input: bigint;
  readonly output: bigint;
  readonly cached: bigint;
}
type BudgetWork<T> = (
  repository: AiBudgetRepository, manager: EntityManager,
  now: Date, authority: AiBudgetAuthority,
) => Promise<T>;

@Injectable()
export class AiBudgetService implements AiBudgetPort {
  constructor(private readonly source: DataSource) {}

  async reserve(input: AiBudgetRequest): Promise<AiBudgetReservation> {
    const request = this.request(input);
    const bound = getProviderBound(request.provider, request.model, request.operation);
    return this.transaction(async (repository, _manager, now, authority) => {
      if (authority.halted) throw new AiBudgetError('AI_BUDGET_USAGE_BOUND_VIOLATED');
      const rules = await this.rules(repository, authority, request);
      assertBudgetCoverage(rules, authority.coverageStart, now);
      const price = await repository.getPrice(request.provider, request.model);
      this.assertPrice(price, request);
      const reservedTokens = BigInt(bound.maxInputTokens) + BigInt(bound.maxOutputTokens);
      // Unknown Anthropic cache creation may be billed at the one-hour 2x
      // input tariff. Ordinary/cache-read actuals can later release that margin.
      const inputMultiplier = request.provider === 'anthropic' ? 2n : 1n;
      const reservedNanos = BigInt(bound.maxInputTokens) * BigInt(price!.inputNanos) * inputMultiplier +
        BigInt(bound.maxOutputTokens) * BigInt(price!.outputNanos);
      await this.checkRules(repository, rules, request, reservedTokens, reservedNanos, now);
      const attempt = this.newAttempt(request, bound, price!, authority.policyVersion!,
        reservedTokens, reservedNanos, now);
      await repository.insertAttempt(attempt);
      return Object.freeze({
        id: attempt.id, provider: request.provider, model: request.model,
        priceVersion: price!.id, ...bound,
      });
    });
  }

  private request(input: AiBudgetRequest): AiBudgetRequest {
    if (!input || typeof input.userId !== 'string' || !BUDGET_UUID.test(input.userId)) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    return Object.freeze({
      userId: input.userId.toLowerCase(), provider: input.provider,
      model: input.model, operation: input.operation,
    });
  }

  private async rules(
    repository: AiBudgetRepository, authority: AiBudgetAuthority, request: AiBudgetRequest,
  ): Promise<readonly AiBudgetRule[]> {
    if (!authority.policyVersion) throw new AiBudgetError('AI_BUDGET_POLICY_MISSING');
    const stored = await repository.getPolicy(authority.policyVersion);
    if (!stored) throw new AiBudgetError('AI_BUDGET_POLICY_MISSING');
    try { return applicableBudgetRules(validateBudgetPolicy(stored), request); } catch {
      throw new AiBudgetError('AI_BUDGET_POLICY_MISSING');
    }
  }

  private assertPrice(price: AiBudgetPrice | null, request: AiBudgetRequest): void {
    if (!price || !BUDGET_UUID.test(price.id) || price.provider !== request.provider ||
        price.model !== request.model) {
      throw new AiBudgetError('AI_BUDGET_PRICE_MISSING');
    }
    try { validateBudgetPrice({ ...price, changeReference: 'OPS-818' }); } catch {
      throw new AiBudgetError('AI_BUDGET_PRICE_MISSING');
    }
  }

  private async checkRules(
    repository: AiBudgetRepository, rules: readonly AiBudgetRule[], request: AiBudgetRequest,
    tokens: bigint, nanos: bigint, now: Date,
  ): Promise<void> {
    let decisions: readonly RuleDecision[] = [];
    for (const rule of rules) {
      decisions = [...decisions, await this.checkRule(repository, rule, request, tokens, nanos, now)];
    }
    if (decisions.some((decision) => decision.tooLarge)) {
      throw new AiBudgetError('AI_REQUEST_EXCEEDS_BUDGET');
    }
    const blocking = decisions.flatMap((decision) => decision.resetAt ? [decision.resetAt] : []);
    if (blocking.length > 0) {
      const latest = new Date(Math.max(...blocking.map((date) => date.getTime())));
      throw new AiBudgetError('AI_BUDGET_EXHAUSTED', latest, now);
    }
  }

  private async checkRule(
    repository: AiBudgetRepository, rule: AiBudgetRule, request: AiBudgetRequest,
    tokens: bigint, nanos: bigint, now: Date,
  ): Promise<RuleDecision> {
    const bonus = rule.scope === 'user' ?
      await repository.getOverride(request.userId, rule.window, now) : { tokens: '0', spendNanos: '0' };
    const tokenLimit = budgetAmount(rule.tokenLimit) + budgetAmount(bonus.tokens, 1000000n);
    const spendLimit = budgetAmount(rule.spendLimitUsdNanos) + budgetAmount(bonus.spendNanos, 100000000000n);
    const consumption = await repository.getConsumption(rule, request, now);
    if (!Number.isSafeInteger(consumption.unknownRequests) || consumption.unknownRequests < 0) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    if (consumption.unknownRequests > 0) throw new AiBudgetError('AI_BUDGET_USAGE_UNPRICED');
    const exceeds = this.aggregate(consumption.tokens) + tokens > tokenLimit ||
      this.aggregate(consumption.spendNanos) + nanos > spendLimit;
    return Object.freeze({
      tooLarge: tokens > tokenLimit || nanos > spendLimit,
      resetAt: exceeds ? getBudgetWindow(rule.window, now).end : null,
    });
  }

  private aggregate(value: string): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$(?![\s\S])/.test(value) || value.length > 64) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    return BigInt(value);
  }

  private newAttempt(
    request: AiBudgetRequest, bound: AiProviderBound, price: AiBudgetPrice,
    policyId: string, tokens: bigint, nanos: bigint, now: Date,
  ): StoredBudgetAttempt {
    return Object.freeze({
      id: randomUUID(), ...request, priceId: price.id, policyId,
      maxInputTokens: String(bound.maxInputTokens), maxOutputTokens: String(bound.maxOutputTokens),
      reservedTokens: tokens.toString(), reservedNanos: nanos.toString(),
      chargedTokens: tokens.toString(), chargedNanos: nanos.toString(),
      actualInputTokens: null, actualOutputTokens: null, state: 'held', outcome: null,
      createdAt: new Date(now.getTime()), settledAt: null,
    });
  }

  async reconcile(
    reservationId: string, outcome: AiBudgetOutcome, usage: AiBudgetUsage | null, latencyMs: number,
  ): Promise<AiBudgetAccounting> {
    if (!BUDGET_UUID.test(reservationId) ||
        !['success', 'provider_error', 'usage_missing'].includes(outcome)) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    let detectedViolation = false;
    let result: ReconcileResult;
    try {
      result = await this.transaction<ReconcileResult>(async (repository, manager, now) => {
        const attempt = await repository.getAttempt(reservationId);
        if (!attempt) throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
        // A finalized unknown hold is never implicitly released by a duplicate callback.
        if (attempt.outcome !== null) return { accounting: this.accounting(attempt), failed: false };
        const price = await repository.getAttemptPrice(attempt.priceId);
        this.assertPrice(price, attempt);
        const settlement = this.settlement(attempt, price!, outcome, usage);
        detectedViolation = settlement.state === 'violated';
        if (detectedViolation) {
          return this.persistViolation(repository, manager, attempt, settlement, latencyMs, now);
        }
        return { accounting: await this.persistSettlement(
          repository, attempt, settlement, latencyMs, now), failed: false };
      });
    } catch (error) {
      // A whole-transaction/commit failure may have lost the halt too. Never
      // refund the reservation; attempt a durable admission halt on the same DB.
      if (detectedViolation) await this.haltAfterFailure();
      throw error;
    }
    // A savepoint failure commits the sticky halt before exposing the safe 503.
    if (result.failed) throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    return result.accounting;
  }

  private async persistSettlement(
    repository: AiBudgetRepository, attempt: StoredBudgetAttempt,
    settlement: StoredBudgetSettlement, latencyMs: number, now: Date,
  ): Promise<AiBudgetAccounting> {
    await repository.settleAttempt(attempt.id, settlement, now);
    await repository.writeUsage(attempt, settlement, settlement.outcome, this.latency(latencyMs), now);
    return this.accounting({ ...attempt, ...settlement });
  }

  private async persistViolation(
    repository: AiBudgetRepository, manager: EntityManager, attempt: StoredBudgetAttempt,
    settlement: StoredBudgetSettlement, latencyMs: number, now: Date,
  ): Promise<ReconcileResult> {
    await manager.query('UPDATE ai_budget_authority SET halted = TRUE WHERE id = 1');
    // Keep the authority lock and halt outside the settlement savepoint. An
    // unavailable usage writer must not create a gap for a new paid admission.
    await manager.query('SAVEPOINT ai_budget_settlement');
    try {
      const accounting = await this.persistSettlement(repository, attempt, settlement, latencyMs, now);
      await manager.query('RELEASE SAVEPOINT ai_budget_settlement');
      return { accounting, failed: false };
    } catch {
      await manager.query('ROLLBACK TO SAVEPOINT ai_budget_settlement');
      await manager.query('RELEASE SAVEPOINT ai_budget_settlement');
      return { accounting: null, failed: true };
    }
  }

  private knownUsage(usage: AiBudgetUsage | null): KnownUsage | null {
    if (!usage || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0]
      .every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
        (usage.cachedInputTokens ?? 0) > usage.inputTokens) return null;
    return Object.freeze({
      input: BigInt(usage.inputTokens), output: BigInt(usage.outputTokens),
      cached: BigInt(usage.cachedInputTokens ?? 0),
    });
  }

  private settlement(
    attempt: StoredBudgetAttempt, price: AiBudgetPrice, outcome: AiBudgetOutcome,
    usage: AiBudgetUsage | null,
  ): StoredBudgetSettlement {
    const known = outcome === 'usage_missing' ? null : this.knownUsage(usage);
    if (!known) return Object.freeze({
      state: 'held', chargedTokens: attempt.reservedTokens, chargedNanos: attempt.reservedNanos,
      actualInputTokens: null, actualOutputTokens: null, outcome,
    });
    const tokens = known.input + known.output;
    const nanos = (known.input - known.cached) * BigInt(price.inputNanos) +
      known.cached * BigInt(price.cachedInputNanos) + known.output * BigInt(price.outputNanos);
    const violated = known.input > BigInt(attempt.maxInputTokens) ||
      known.output > BigInt(attempt.maxOutputTokens);
    return Object.freeze({
      state: violated ? 'violated' : 'settled', outcome,
      actualInputTokens: known.input.toString(), actualOutputTokens: known.output.toString(),
      chargedTokens: (violated ? this.violationCharge(tokens, attempt.reservedTokens) : tokens).toString(),
      chargedNanos: (violated ? this.violationCharge(nanos, attempt.reservedNanos) : nanos).toString(),
    });
  }

  private violationCharge(actual: bigint, reserved: string): bigint {
    const hold = BigInt(reserved);
    const charge = actual > hold ? actual : hold;
    // A pathological provider count can produce a price product beyond bigint.
    // Saturating at every policy's maximum, retaining actual evidence, and halting
    // prevents arithmetic overflow from reopening admission or refunding a hold.
    return charge > MAX_BUDGET_AMOUNT ? MAX_BUDGET_AMOUNT : charge;
  }

  private accounting(attempt: Pick<StoredBudgetAttempt,
    'state' | 'chargedTokens' | 'chargedNanos' | 'priceId' | 'actualInputTokens' | 'actualOutputTokens'>,
  ): AiBudgetAccounting {
    const actual = attempt.actualInputTokens === null || attempt.actualOutputTokens === null ? null :
      BigInt(attempt.actualInputTokens) + BigInt(attempt.actualOutputTokens);
    return Object.freeze({
      state: attempt.state,
      actualTokens: actual === null || actual > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(actual),
      chargedTokens: attempt.chargedTokens, chargedSpendUsdNanos: attempt.chargedNanos,
      priceVersion: attempt.priceId,
    });
  }

  private latency(value: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ?
      Math.min(Math.round(value), 2147483647) : 0;
  }

  private async haltAfterFailure(): Promise<void> {
    await this.transaction(async (_repository, manager) => {
      await manager.query('UPDATE ai_budget_authority SET halted = TRUE WHERE id = 1');
    });
  }

  async getUserUsage(userId: string): Promise<AiBudgetUserUsage> {
    if (typeof userId !== 'string' || !BUDGET_UUID.test(userId)) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    return this.transaction(async (repository, _manager, now) => Object.freeze({
      windows: Object.freeze([
        await repository.getUserWindow(userId.toLowerCase(), 'day', now),
        await repository.getUserWindow(userId.toLowerCase(), 'month', now),
      ]),
    }));
  }

  async withAuthority<T>(
    manager: EntityManager,
    work: (now: Date, authority: AiBudgetAuthority) => Promise<T>,
  ): Promise<T> {
    this.assertSource();
    const runner = manager.queryRunner;
    if (!runner || manager.connection !== this.source || runner.connection !== this.source ||
        !runner.isTransactionActive || runner.isReleased) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    const snapshot = await this.safe(() => this.authoritySnapshot(manager));
    // Preserve callback validation errors for the existing administrative API.
    return work(snapshot.now, snapshot.authority);
  }

  private async authoritySnapshot(manager: EntityManager) {
    const rows = await manager.query(
      'SELECT policy_version, coverage_start, halted FROM ai_budget_authority WHERE id = 1 FOR UPDATE');
    if (rows.length !== 1 || typeof rows[0].halted !== 'boolean' ||
        (rows[0].policy_version !== null && !BUDGET_UUID.test(rows[0].policy_version))) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    // clock_timestamp(), rather than transaction_timestamp(), is sampled after a
    // potentially long lock wait, so a waiter cannot spend the preceding window.
    const clock = await manager.query('SELECT clock_timestamp() AS now');
    const now = new Date(clock[0]?.now);
    const coverageStart = rows[0].coverage_start === null ? null : new Date(rows[0].coverage_start);
    if (!Number.isFinite(now.getTime()) ||
        (coverageStart !== null && !Number.isFinite(coverageStart.getTime()))) {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
    return Object.freeze({
      now, authority: Object.freeze({
        policyVersion: rows[0].policy_version, coverageStart, halted: rows[0].halted,
      }) as AiBudgetAuthority,
    });
  }

  private assertSource(): void {
    if (!this.source.isInitialized || this.source.options.type !== 'postgres') {
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
  }

  private transaction<T>(work: BudgetWork<T>): Promise<T> {
    return this.safe(async () => {
      this.assertSource();
      return this.source.transaction('READ COMMITTED', (manager) =>
        this.withAuthority(manager, (now, authority) =>
          work(new AiBudgetRepository(manager), manager, now, authority)));
    });
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof AiBudgetError) throw error;
      throw new AiBudgetError('AI_BUDGET_UNAVAILABLE');
    }
  }
}
