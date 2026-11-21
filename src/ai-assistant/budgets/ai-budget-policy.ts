import { BadRequestException } from '@nestjs/common';
import { AiBudgetError } from './ai-budget.errors';
import { getProviderBound } from './ai-provider-bound';
import {
  AiBudgetPriceInput, AiBudgetRequest, AiBudgetRule, AiBudgetWindow,
} from './ai-budget.types';

export const MAX_BUDGET_AMOUNT = 9000000000000000000n;
export const BUDGET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const DECIMAL = /^(0|[1-9][0-9]*)$(?![\s\S])/;

/** Limits and single-row charges fit a signed PostgreSQL bigint without rounding. */
export function budgetAmount(value: unknown, maximum = MAX_BUDGET_AMOUNT): bigint {
  if (typeof value !== 'string' || value.length > 19 || !DECIMAL.test(value)) {
    throw new BadRequestException('Invalid AI budget amount');
  }
  const amount = BigInt(value);
  if (amount > maximum) throw new BadRequestException('Invalid AI budget amount');
  return amount;
}

function canonicalRule(input: AiBudgetRule): AiBudgetRule {
  if (!input || typeof input !== 'object' ||
      Object.keys(input).some((key) => ![
        'scope', 'subject', 'window', 'tokenLimit', 'spendLimitUsdNanos',
      ].includes(key)) ||
      !['user', 'provider', 'global'].includes(input.scope) ||
      !['day', 'month'].includes(input.window) || typeof input.subject !== 'string') {
    throw new BadRequestException('Invalid AI budget rule');
  }
  const subject = input.subject.toLowerCase();
  const validSubject = input.scope === 'global' ? subject === '*' :
    input.scope === 'provider' ? ['openai', 'anthropic'].includes(subject) :
      subject === '*' || BUDGET_UUID.test(subject);
  if (!validSubject) throw new BadRequestException('Invalid AI budget rule subject');
  budgetAmount(input.tokenLimit);
  budgetAmount(input.spendLimitUsdNanos);
  return Object.freeze({
    scope: input.scope, subject, window: input.window,
    tokenLimit: input.tokenLimit, spendLimitUsdNanos: input.spendLimitUsdNanos,
  });
}

function hasDefaults(rules: readonly AiBudgetRule[]): boolean {
  return rules.some((rule) => rule.scope === 'user' && rule.subject === '*') &&
    rules.some((rule) => rule.scope === 'global' && rule.subject === '*') &&
    ['openai', 'anthropic'].every((provider) =>
      rules.some((rule) => rule.scope === 'provider' && rule.subject === provider));
}

export function validateBudgetPolicy(rules: readonly AiBudgetRule[]): readonly AiBudgetRule[] {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 32) {
    throw new BadRequestException('Invalid AI budget policy');
  }
  const canonical = rules.map(canonicalRule);
  const keys = canonical.map((rule) => [rule.scope, rule.subject, rule.window].join(':'));
  if (new Set(keys).size !== keys.length || !hasDefaults(canonical)) {
    throw new BadRequestException('AI budget policy requires unique user, provider and global limits');
  }
  return Object.freeze(canonical);
}

export function applicableBudgetRules(
  rules: readonly AiBudgetRule[],
  request: AiBudgetRequest,
): readonly AiBudgetRule[] {
  const applicable = rules.filter((rule) => rule.scope === 'global' ||
    (rule.scope === 'provider' && rule.subject === request.provider) ||
    (rule.scope === 'user' && (rule.subject === '*' || rule.subject === request.userId)));
  if (!['user', 'provider', 'global'].every((scope) =>
    applicable.some((rule) => rule.scope === scope &&
      (scope !== 'user' || rule.subject === '*')))) {
    throw new AiBudgetError('AI_BUDGET_POLICY_MISSING');
  }
  return Object.freeze(applicable);
}

export function getBudgetWindow(
  window: AiBudgetWindow,
  now: Date,
): Readonly<{ start: Date; end: Date }> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !['day', 'month'].includes(window)) {
    throw new BadRequestException('Invalid AI budget window');
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = window === 'day' ? now.getUTCDate() : 1;
  return Object.freeze({
    start: new Date(Date.UTC(year, month, day)),
    end: window === 'day' ? new Date(Date.UTC(year, month, day + 1)) :
      new Date(Date.UTC(year, month + 1, 1)),
  });
}

/**
 * The marker is set only after old replicas/in-flight work have been quiesced.
 * No admission starts until every applicable UTC window begins after it.
 * This drains unimported/unpriced legacy usage without inventing a zero baseline.
 */
export function assertBudgetCoverage(
  rules: readonly AiBudgetRule[],
  coverageStart: Date | null,
  now: Date,
): void {
  if (!coverageStart || !Number.isFinite(coverageStart.getTime()) ||
      rules.some((rule) => getBudgetWindow(rule.window, now).start.getTime() <
        coverageStart.getTime())) {
    throw new AiBudgetError('AI_BUDGET_ACCOUNTING_NOT_READY');
  }
}

export function validateBudgetPrice(input: AiBudgetPriceInput): void {
  if (!input || typeof input !== 'object') {
    throw new BadRequestException('Invalid AI budget price');
  }
  const operation = input.model === 'text-embedding-3-small' ? 'embedding' : 'chat';
  try { getProviderBound(input.provider, input.model, operation); } catch {
    throw new BadRequestException('Invalid AI budget price model');
  }
  const inputNanos = budgetAmount(input.inputNanos, 1000000000n);
  const outputNanos = budgetAmount(input.outputNanos, 1000000000n);
  const cachedNanos = budgetAmount(input.cachedInputNanos, 1000000000n);
  if (inputNanos === 0n || cachedNanos > inputNanos ||
      (operation === 'chat' ? outputNanos === 0n : outputNanos !== 0n)) {
    throw new BadRequestException('Invalid AI budget price rates');
  }
}
