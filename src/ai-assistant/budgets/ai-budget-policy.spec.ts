import { BadRequestException } from '@nestjs/common';
import { AiBudgetError } from './ai-budget.errors';
import {
  applicableBudgetRules,
  assertBudgetCoverage,
  getBudgetWindow,
  validateBudgetPolicy,
  validateBudgetPrice,
} from './ai-budget-policy';
import { getProviderBound } from './ai-provider-bound';
import { AiBudgetPriceInput, AiBudgetRequest, AiBudgetRule } from './ai-budget.types';

const userId = '00000000-0000-4000-8000-000000000001';
const request: AiBudgetRequest = {
  userId, provider: 'openai', model: 'gpt-4o-mini', operation: 'chat',
};
const rule = (scope: AiBudgetRule['scope'], subject: string,
  window: AiBudgetRule['window'] = 'day'): AiBudgetRule => ({
  scope, subject, window, tokenLimit: '1000000', spendLimitUsdNanos: '1000000000',
});
const rules = (): readonly AiBudgetRule[] => [
  rule('user', '*'), rule('global', '*'),
  rule('provider', 'openai'), rule('provider', 'anthropic'),
];
const price = (): AiBudgetPriceInput => ({
  provider: 'openai', model: 'gpt-4o-mini',
  inputNanos: '2', outputNanos: '3', cachedInputNanos: '1',
  changeReference: 'OPS-818',
});

describe('immutable AI budget policy and proven model bounds', () => {
  it('copies rules instead of retaining caller-owned objects', () => {
    const input = Object.freeze(rules().map((item) => Object.freeze(item)));
    const result = validateBudgetPolicy(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    result.forEach((item, index) => expect(item).not.toBe(input[index]));
  });

  it.each(['-1', '+1', '01', ' 1', '1 ', '1.0', '1e6', '1\n', '1\r', '1\r\n',
    '9000000000000000001', '', 1, null])(
    'rejects noncanonical or oversized policy amount %p', (amount) => {
      expect(() => validateBudgetPolicy([
        { ...rules()[0], tokenLimit: amount as string }, ...rules().slice(1),
      ])).toThrow(BadRequestException);
    },
  );

  it('accepts zero limits and exact bigint maxima without Number rounding', () => {
    expect(validateBudgetPolicy([
      { ...rules()[0], tokenLimit: '0',
        spendLimitUsdNanos: '9000000000000000000' }, ...rules().slice(1),
    ])[0].spendLimitUsdNanos).toBe('9000000000000000000');
  });

  it('rejects duplicates, unsupported scopes/windows, missing defaults and >32 rules', () => {
    const invalid = [
      [...rules(), rules()[0]],
      [{ ...rules()[0], window: 'week' }, ...rules().slice(1)],
      [{ ...rules()[0], scope: 'tenant' }, ...rules().slice(1)],
      rules().slice(1),
      [...rules().slice(0, 2), rule('provider', '*')],
      [...rules(), ...Array.from({ length: 29 }, (_, index) =>
        rule('user', '00000000-0000-4000-8000-' + String(index + 10).padStart(12, '0')))],
    ];
    invalid.forEach((input) => expect(() =>
      validateBudgetPolicy(input as readonly AiBudgetRule[])).toThrow(BadRequestException));
  });

  it('normalizes UUID subjects and makes personal limits cumulative with defaults', () => {
    const personal = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const input = validateBudgetPolicy([...rules(), rule('user', personal, 'month')]);
    expect(input[4].subject).toBe(personal.toLowerCase());
    expect(applicableBudgetRules(input, { ...request, userId: personal.toLowerCase() }))
      .toEqual([input[0], input[1], input[2], input[4]]);
    expect(applicableBudgetRules(input, request)).toEqual(input.slice(0, 3));
  });

  it('fails closed if a required applicable scope is missing', () => {
    expect(() => applicableBudgetRules(rules().filter((item) =>
      item.scope !== 'global'), request)).toThrow(AiBudgetError);
  });

  it('uses fixed UTC calendar windows, including leap years and offset inputs', () => {
    const now = new Date('2028-02-29T23:30:00-05:00');
    expect(getBudgetWindow('day', now)).toEqual({
      start: new Date('2028-03-01T00:00:00Z'), end: new Date('2028-03-02T00:00:00Z'),
    });
    expect(getBudgetWindow('month', now)).toEqual({
      start: new Date('2028-03-01T00:00:00Z'), end: new Date('2028-04-01T00:00:00Z'),
    });
    expect(now.toISOString()).toBe('2028-03-01T04:30:00.000Z');
  });

  it('requires every applicable window to have drained since durable coverage', () => {
    const now = new Date('2026-11-21T12:00:00Z');
    const applicable = [...rules().slice(0, 3), rule('user', userId, 'month')];
    for (const marker of [null, new Date('2026-11-21T00:00:00Z'),
      new Date('2026-11-01T00:00:00.001Z')]) {
      expect(() => assertBudgetCoverage(applicable, marker, now)).toThrow(AiBudgetError);
    }
    expect(() => assertBudgetCoverage(applicable, new Date('2026-11-01T00:00:00Z'), now))
      .not.toThrow();
  });

  it.each([
    ['openai', 'gpt-4o-mini', 'chat', 128000, 16384],
    ['anthropic', 'claude-3-haiku-20240307', 'chat', 200000, 1024],
    ['openai', 'text-embedding-3-small', 'embedding', 8192, 0],
  ] as const)('provides the full proven model bounds for %s %s %s',
    (provider, model, operation, maxInputTokens, maxOutputTokens) => {
      expect(getProviderBound(provider, model, operation))
        .toEqual({ maxInputTokens, maxOutputTokens });
    });

  it.each([
    ['anthropic', 'gpt-4o-mini', 'chat'],
    ['openai', 'text-embedding-3-small', 'chat'],
    ['openai', 'gpt-4o-mini', 'embedding'],
    ['openai', 'unknown-model', 'chat'],
  ] as const)('denies mismatched or unproven paid branches', (provider, model, operation) => {
    expect(() => getProviderBound(provider, model, operation)).toThrow(AiBudgetError);
  });

  it('validates chat, cached-input and embeddings price constraints', () => {
    expect(() => validateBudgetPrice(price())).not.toThrow();
    const invalid = [
      { ...price(), inputNanos: '0' }, { ...price(), outputNanos: '0' },
      { ...price(), cachedInputNanos: '3' }, { ...price(), inputNanos: '1000000001' },
      { ...price(), model: 'unsupported' }, { ...price(), outputNanos: '03' },
    ];
    invalid.forEach((input) => expect(() => validateBudgetPrice(input))
      .toThrow(BadRequestException));
    expect(() => validateBudgetPrice({
      ...price(), model: 'text-embedding-3-small', outputNanos: '0',
    })).not.toThrow();
    expect(() => validateBudgetPrice({
      ...price(), model: 'text-embedding-3-small', outputNanos: '1',
    })).toThrow(BadRequestException);
  });
});
