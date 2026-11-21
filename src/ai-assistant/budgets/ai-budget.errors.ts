import { HttpException, HttpStatus } from '@nestjs/common';

const MESSAGES = {
  AI_BUDGET_EXHAUSTED: 'AI budget is exhausted.',
  AI_REQUEST_EXCEEDS_BUDGET: 'AI request exceeds the configured budget.',
  AI_BUDGET_UNAVAILABLE: 'AI budget accounting is unavailable.',
  AI_BUDGET_POLICY_MISSING: 'AI budget policy is not configured.',
  AI_BUDGET_PRICE_MISSING: 'AI provider price is not configured.',
  AI_BUDGET_ACCOUNTING_NOT_READY: 'AI budget accounting is not ready.',
  AI_BUDGET_USAGE_UNPRICED: 'Historical AI usage cannot be priced.',
  AI_BUDGET_USAGE_BOUND_VIOLATED: 'AI usage exceeded its verified limit.',
  AI_BUDGET_PROVIDER_UNSUPPORTED: 'AI provider or model has no verified budget bound.',
} as const;

export type AiBudgetErrorCode = keyof typeof MESSAGES;

export interface AiBudgetErrorResponse {
  readonly code: AiBudgetErrorCode;
  readonly state: 'exhausted' | 'request_too_large' | 'unavailable';
  readonly message: string;
  readonly resetAt: string | null;
  readonly retryAfterSeconds: number | null;
}

/** Only this server-owned exception exposes budget retry metadata publicly. */
export class AiBudgetError extends HttpException {
  constructor(
    code: AiBudgetErrorCode,
    resetAt: Date | null = null,
    databaseNow: Date | null = null,
  ) {
    const oversized = code === 'AI_REQUEST_EXCEEDS_BUDGET';
    const validReset = !oversized && resetAt instanceof Date &&
      Number.isFinite(resetAt.getTime()) ? resetAt : null;
    const validNow = databaseNow instanceof Date &&
      Number.isFinite(databaseNow.getTime()) ? databaseNow : null;
    const delay = validReset && validNow ?
      Math.max(0, Math.ceil((validReset.getTime() - validNow.getTime()) / 1000)) : null;
    const response: AiBudgetErrorResponse = Object.freeze({
      code,
      state: code === 'AI_BUDGET_EXHAUSTED' ? 'exhausted' :
        oversized ? 'request_too_large' : 'unavailable',
      message: MESSAGES[code],
      resetAt: validReset?.toISOString() ?? null,
      retryAfterSeconds: delay !== null && Number.isSafeInteger(delay) ? delay : null,
    });
    const status = code === 'AI_BUDGET_EXHAUSTED' ? HttpStatus.TOO_MANY_REQUESTS :
      oversized ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.SERVICE_UNAVAILABLE;
    super(response, status);
  }

  override getResponse(): AiBudgetErrorResponse {
    return super.getResponse() as AiBudgetErrorResponse;
  }
}
