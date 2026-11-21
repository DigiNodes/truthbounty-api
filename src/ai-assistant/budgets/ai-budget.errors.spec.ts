import { AiBudgetError } from './ai-budget.errors';

describe('AiBudgetError', () => {
  it('uses the database time to calculate a rounded-up retry delay', () => {
    const error = new AiBudgetError(
      'AI_BUDGET_EXHAUSTED',
      new Date('2026-12-01T00:00:00.000Z'),
      new Date('2026-11-30T23:59:59.500Z'),
    );
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      code: 'AI_BUDGET_EXHAUSTED',
      state: 'exhausted',
      message: 'AI budget is exhausted.',
      resetAt: '2026-12-01T00:00:00.000Z',
      retryAfterSeconds: 1,
    });
  });

  it('cannot suggest a reset for a request that does not fit an empty quota', () => {
    const error = new AiBudgetError(
      'AI_REQUEST_EXCEEDS_BUDGET',
      new Date('2026-12-01T00:00:00.000Z'),
      new Date('2026-11-21T00:00:00.000Z'),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      resetAt: null,
      retryAfterSeconds: null,
    });
  });

  it('treats missing price configuration as unavailable rather than exhaustion', () => {
    const error = new AiBudgetError('AI_BUDGET_PRICE_MISSING');
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'AI_BUDGET_PRICE_MISSING',
      state: 'unavailable',
      resetAt: null,
      retryAfterSeconds: null,
    });
  });

  it('has an immutable, limited response with no provider/user/budget data', () => {
    const response = new AiBudgetError('AI_BUDGET_UNAVAILABLE').getResponse();
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.keys(response).sort()).toEqual(
      ['code', 'message', 'resetAt', 'retryAfterSeconds', 'state'].sort(),
    );
  });

  it('omits an invalid reset timestamp and never returns an invalid header delay', () => {
    expect(
      new AiBudgetError('AI_BUDGET_ACCOUNTING_NOT_READY', new Date(NaN), new Date())
        .getResponse(),
    ).toMatchObject({ resetAt: null, retryAfterSeconds: null });
  });
});
