import { AiBudgetError } from './ai-budget.errors';
import { AiBudgetOperation, AiProviderBound, PaidAiProvider } from './ai-budget.types';

/**
 * Admission reserves the complete model input ceiling, including framing and
 * retrieved context. A character or tokenizer estimate cannot prove that bound.
 * Each reservation authorizes one SDK attempt, with SDK retries disabled.
 */
export function getProviderBound(
  provider: PaidAiProvider,
  model: string,
  operation: AiBudgetOperation,
): AiProviderBound {
  if (provider === 'openai' && model === 'gpt-4o-mini' && operation === 'chat') {
    return Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 16384 });
  }
  if (provider === 'anthropic' && model === 'claude-3-haiku-20240307' && operation === 'chat') {
    return Object.freeze({ maxInputTokens: 200000, maxOutputTokens: 1024 });
  }
  if (provider === 'openai' && model === 'text-embedding-3-small' && operation === 'embedding') {
    return Object.freeze({ maxInputTokens: 8192, maxOutputTokens: 0 });
  }
  throw new AiBudgetError('AI_BUDGET_PROVIDER_UNSUPPORTED');
}
