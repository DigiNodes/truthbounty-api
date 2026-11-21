import { EntityManager } from 'typeorm';

export type PaidAiProvider = 'openai' | 'anthropic';
export type AiBudgetOperation = 'chat' | 'embedding';
export type AiBudgetWindow = 'day' | 'month';
export type AiBudgetScope = 'user' | 'provider' | 'global';

export interface AiBudgetRequest {
  readonly userId: string;
  readonly provider: PaidAiProvider;
  readonly model: string;
  readonly operation: AiBudgetOperation;
}

export interface AiProviderBound {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface AiBudgetReservation extends AiProviderBound {
  readonly id: string;
  readonly provider: PaidAiProvider;
  readonly model: string;
  readonly priceVersion: string;
}

export interface AiBudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type AiBudgetOutcome = 'success' | 'provider_error' | 'usage_missing';
export type AiBudgetState = 'held' | 'settled' | 'violated';

export interface AiBudgetAccounting {
  readonly state: AiBudgetState;
  readonly actualTokens: number | null;
  readonly chargedTokens: string;
  readonly chargedSpendUsdNanos: string;
  readonly priceVersion: string;
}

export interface AiBudgetRule {
  readonly scope: AiBudgetScope;
  readonly subject: string;
  readonly window: AiBudgetWindow;
  readonly tokenLimit: string;
  readonly spendLimitUsdNanos: string;
}

export interface AiBudgetAuthority {
  readonly policyVersion: string | null;
  readonly coverageStart: Date | null;
  readonly halted: boolean;
}

export interface AiBudgetPrice {
  readonly id: string;
  readonly provider: PaidAiProvider;
  readonly model: string;
  readonly inputNanos: string;
  readonly outputNanos: string;
  readonly cachedInputNanos: string;
}

export interface AiBudgetActor {
  readonly id: string;
  readonly role: string;
}

export interface AiBudgetPriceInput {
  readonly provider: PaidAiProvider;
  readonly model: string;
  readonly inputNanos: string;
  readonly outputNanos: string;
  readonly cachedInputNanos: string;
  readonly changeReference: string;
}

export interface AiBudgetPolicyInput {
  readonly rules: readonly AiBudgetRule[];
  readonly changeReference: string;
}

export interface AiBudgetOverrideInput {
  readonly userId: string;
  readonly window: AiBudgetWindow;
  readonly extraTokens: string;
  readonly extraSpendUsdNanos: string;
  readonly expiresAt: string;
  readonly changeReference: string;
}

export interface AiBudgetUserWindow {
  readonly window: AiBudgetWindow;
  readonly startAt: string;
  readonly resetAt: string;
  readonly actualTokens: string;
  readonly chargedTokens: string;
  readonly chargedSpendUsdNanos: string | null;
  readonly uncertainRequests: number;
}

export interface AiBudgetUserUsage {
  readonly windows: readonly AiBudgetUserWindow[];
}

/** Server-only port shared by admission, reconciliation and administration. */
export interface AiBudgetPort {
  reserve(request: AiBudgetRequest): Promise<AiBudgetReservation>;
  reconcile(
    reservationId: string,
    outcome: AiBudgetOutcome,
    usage: AiBudgetUsage | null,
    latencyMs: number,
  ): Promise<AiBudgetAccounting>;
  getUserUsage(userId: string): Promise<AiBudgetUserUsage>;
  withAuthority<T>(
    manager: EntityManager,
    work: (now: Date, authority: AiBudgetAuthority) => Promise<T>,
  ): Promise<T>;
}
