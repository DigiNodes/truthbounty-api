import {
  DeliveryRetryBudget,
  computeRetryDelay,
  planDeliveryRetry,
} from './delivery-retry.policy';
import { DeliveryFailureKind } from './delivery-error';

/** Constant randomness: keeps jitter deterministic and centred (offset 0). */
const noJitterOffset = () => 0.5;

const deterministicBudget: DeliveryRetryBudget = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
  jitterRatio: 0,
};

describe('delivery retry policy', () => {
  describe('computeRetryDelay', () => {
    it('applies deterministic exponential backoff capped at maxDelayMs', () => {
      expect(computeRetryDelay(0, deterministicBudget)).toBe(1000);
      expect(computeRetryDelay(1, deterministicBudget)).toBe(2000);
      expect(computeRetryDelay(2, deterministicBudget)).toBe(4000);
      expect(computeRetryDelay(10, deterministicBudget)).toBe(30000);
    });

    it('never returns a negative delay', () => {
      const budget = { ...deterministicBudget, jitterRatio: 1 };
      expect(computeRetryDelay(0, budget, () => 0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('planDeliveryRetry', () => {
    it('retries a provider timeout within budget', () => {
      const plan = planDeliveryRetry(new Error('request timed out'), 0, {
        random: noJitterOffset,
      });
      expect(plan.action).toBe('retry');
      expect(plan.kind).toBe(DeliveryFailureKind.TIMEOUT);
      expect(plan.disposition).toBe('retryable');
      expect(plan.delayMs).toBe(1000);
      expect(plan.nextAttempt).toBe(1);
    });

    it('retries a transient 5xx with exponential backoff', () => {
      const first = planDeliveryRetry({ response: { status: 503 } }, 0, {
        random: noJitterOffset,
      });
      const second = planDeliveryRetry({ response: { status: 503 } }, 1, {
        random: noJitterOffset,
      });
      expect(first.action).toBe('retry');
      expect(second.action).toBe('retry');
      expect(second.delayMs).toBeGreaterThan(first.delayMs);
    });

    it('dead-letters terminal failures immediately', () => {
      const plan = planDeliveryRetry({ response: { status: 400 } }, 0, {
        random: noJitterOffset,
      });
      expect(plan.action).toBe('dead_letter');
      expect(plan.disposition).toBe('terminal');
      expect(plan.delayMs).toBe(0);
      expect(plan.reason).toContain('Terminal');
    });

    it('dead-letters after the retry budget is exhausted', () => {
      const plan = planDeliveryRetry(new Error('request timed out'), 5, {
        random: noJitterOffset,
        budget: { maxAttempts: 5 },
      });
      expect(plan.action).toBe('dead_letter');
      expect(plan.delayMs).toBe(0);
      expect(plan.reason).toContain('budget exhausted');
    });

    it('honours a custom budget for both delay and ceiling', () => {
      const budget: Partial<DeliveryRetryBudget> = {
        maxAttempts: 2,
        initialDelayMs: 100,
        backoffMultiplier: 3,
        maxDelayMs: 5000,
        jitterRatio: 0,
      };

      const retry = planDeliveryRetry(new Error('timeout'), 1, {
        random: noJitterOffset,
        budget,
      });
      expect(retry.action).toBe('retry');
      expect(retry.delayMs).toBe(300);

      const exhausted = planDeliveryRetry(new Error('timeout'), 2, {
        random: noJitterOffset,
        budget,
      });
      expect(exhausted.action).toBe('dead_letter');
    });

    it('never retries malformed, duplicate, or permanent failures', () => {
      const terminalErrors: unknown[] = [
        new SyntaxError('bad json'),
        { code: '23505' },
        new Error('permanent invalid recipient'),
        { response: { status: 422 } },
      ];

      for (const error of terminalErrors) {
        const plan = planDeliveryRetry(error, 0, { random: noJitterOffset });
        expect(plan.action).toBe('dead_letter');
        expect(plan.disposition).toBe('terminal');
      }
    });

    it('fails closed (dead-letter) for unknown errors', () => {
      const plan = planDeliveryRetry(new Error('unprecedented'), 0, {
        random: noJitterOffset,
      });
      expect(plan.kind).toBe(DeliveryFailureKind.UNKNOWN);
      expect(plan.action).toBe('dead_letter');
    });

    it('exposes the narrowed error on the plan', () => {
      const plan = planDeliveryRetry({ code: 'ETIMEDOUT' }, 0, {
        random: noJitterOffset,
      });
      expect(plan.error).toBeInstanceOf(Error);
      expect(plan.error.kind).toBe(DeliveryFailureKind.TIMEOUT);
    });
  });
});
