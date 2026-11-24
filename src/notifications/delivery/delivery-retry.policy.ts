import { getRetryPolicy } from '../../queue/retry-utils';
import { DeliveryChannel } from '../interfaces/notification.types';
import {
  DeliveryFailureKind,
  NotificationDeliveryError,
  RetryDisposition,
  narrowDeliveryError,
} from './delivery-error';

/**
 * Budget that bounds how many times a retryable delivery failure may be
 * attempted before it is dead-lettered. Overrides the shared queue policy on a
 * per-call basis; omitted fields fall back to that policy.
 */
export interface DeliveryRetryBudget {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export type DeliveryRetryAction = 'retry' | 'dead_letter';

export interface DeliveryRetryPlan {
  action: DeliveryRetryAction;
  kind: DeliveryFailureKind;
  disposition: RetryDisposition;
  classification: NotificationDeliveryError['classification'];
  /** Attempt that produced this plan (0-based). */
  attempt: number;
  /** Attempt number to record for the next execution (only meaningful on retry). */
  nextAttempt: number;
  delayMs: number;
  reason: string;
  error: NotificationDeliveryError;
}

export interface PlanDeliveryRetryOptions {
  budget?: Partial<DeliveryRetryBudget>;
  /** Injectable randomness so backoff (and tests) are deterministic. */
  random?: () => number;
  channel?: DeliveryChannel | null;
}

/**
 * Deterministic exponential backoff with optional symmetric jitter.
 *
 * `random` defaults to `Math.random`, but callers (and tests) can inject a
 * constant to make the delay reproducible.
 */
export function computeRetryDelay(
  attempt: number,
  budget: DeliveryRetryBudget,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.trunc(attempt));
  const base = Math.min(
    budget.initialDelayMs * Math.pow(budget.backoffMultiplier, safeAttempt),
    budget.maxDelayMs,
  );

  if (budget.jitterRatio <= 0) {
    return Math.max(0, Math.floor(base));
  }

  const jitter = base * budget.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.floor(base + jitter));
}

/**
 * Decide whether a failed delivery is retried or dead-lettered.
 *
 * Terminal failures always produce `dead_letter` immediately; retryable
 * failures retry until the budget is exhausted, then dead-letter. The result is
 * a pure function of (error, attempt, options), so outcomes are deterministic.
 */
export function planDeliveryRetry(
  error: unknown,
  attempt: number,
  options: PlanDeliveryRetryOptions = {},
): DeliveryRetryPlan {
  const narrowed = narrowDeliveryError(error, { channel: options.channel });
  const basePolicy = getRetryPolicy(narrowed.classification);
  const safeAttempt = Math.max(0, Math.trunc(attempt));

  const budget: DeliveryRetryBudget = {
    maxAttempts: options.budget?.maxAttempts ?? basePolicy.maxAttempts,
    initialDelayMs: options.budget?.initialDelayMs ?? basePolicy.initialDelayMs,
    backoffMultiplier:
      options.budget?.backoffMultiplier ?? basePolicy.backoffMultiplier,
    maxDelayMs: options.budget?.maxDelayMs ?? basePolicy.maxDelayMs,
    jitterRatio:
      options.budget?.jitterRatio ??
      (basePolicy.jitterEnabled ? basePolicy.jitterRatio : 0),
  };

  const shared = {
    kind: narrowed.kind,
    disposition: narrowed.disposition,
    classification: narrowed.classification,
    attempt: safeAttempt,
    error: narrowed,
  };

  if (narrowed.disposition === 'terminal') {
    return {
      ...shared,
      action: 'dead_letter',
      nextAttempt: safeAttempt,
      delayMs: 0,
      reason: `Terminal ${narrowed.kind} failure — no retry`,
    };
  }

  if (safeAttempt >= budget.maxAttempts) {
    return {
      ...shared,
      action: 'dead_letter',
      nextAttempt: safeAttempt,
      delayMs: 0,
      reason: `Retry budget exhausted (${safeAttempt}/${budget.maxAttempts})`,
    };
  }

  return {
    ...shared,
    action: 'retry',
    nextAttempt: safeAttempt + 1,
    delayMs: computeRetryDelay(safeAttempt, budget, options.random),
    reason: `Retryable ${narrowed.kind} failure — retry ${safeAttempt + 1}/${budget.maxAttempts}`,
  };
}
