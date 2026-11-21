import {
  BadGatewayException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AiBudgetService } from '../budgets/ai-budget.service';
import {
  AiBudgetAccounting,
  AiBudgetOperation,
  AiBudgetPort,
  AiBudgetRequest,
  AiBudgetReservation,
  AiBudgetUsage,
  PaidAiProvider,
} from '../budgets/ai-budget.types';

interface LlmMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

interface LlmOptions {
  readonly userId?: string;
  readonly provider?: PaidAiProvider;
}

export interface LlmResponse {
  readonly content: string;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  } | null;
  readonly provider: PaidAiProvider | 'mock';
  readonly model: string;
  readonly accounting: AiBudgetAccounting | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function openaiUsage(
  value: unknown,
  operation: AiBudgetOperation,
): AiBudgetUsage | null {
  const usage = record(value);
  if (!usage || !tokenCount(usage.prompt_tokens)) return null;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = operation === 'embedding' ? 0 : usage.completion_tokens;
  if (!tokenCount(outputTokens) || !tokenCount(inputTokens + outputTokens)) {
    return null;
  }
  if (
    usage.total_tokens !== undefined &&
    usage.total_tokens !== inputTokens + outputTokens
  ) {
    return null;
  }
  const details = record(usage.prompt_tokens_details);
  if (usage.prompt_tokens_details != null && !details) return null;
  const cachedInputTokens = details?.cached_tokens;
  if (
    cachedInputTokens !== undefined &&
    (!tokenCount(cachedInputTokens) || cachedInputTokens > inputTokens)
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function anthropicUsage(value: unknown): AiBudgetUsage | null {
  const usage = record(value);
  if (
    !usage ||
    !tokenCount(usage.input_tokens) ||
    !tokenCount(usage.output_tokens)
  ) {
    return null;
  }
  const cachedInputTokens = usage.cache_read_input_tokens;
  const createdInputTokens = usage.cache_creation_input_tokens;
  if (cachedInputTokens != null && !tokenCount(cachedInputTokens)) return null;
  // This path never sends cache_control. An unexpected cache-creation premium
  // cannot be settled under the normal-input/cache-read tariff: retain the hold.
  if (
    createdInputTokens != null &&
    (!tokenCount(createdInputTokens) || createdInputTokens > 0)
  ) {
    return null;
  }
  // Anthropic input_tokens excludes cache reads, unlike OpenAI prompt_tokens.
  const inputTokens = usage.input_tokens + (cachedInputTokens ?? 0);
  if (
    !tokenCount(inputTokens) ||
    !tokenCount(inputTokens + usage.output_tokens)
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens: usage.output_tokens,
    ...(cachedInputTokens == null ? {} : { cachedInputTokens }),
  };
}

function legacyUsage(usage: AiBudgetUsage | null): LlmResponse['usage'] {
  return usage
    ? {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      }
    : null;
}

function providerFailure(): BadGatewayException {
  return new BadGatewayException({
    code: 'AI_PROVIDER_ERROR',
    state: 'unavailable',
  });
}

@Injectable()
export class LlmProviderService {
  private readonly openai: OpenAI | null;
  private readonly anthropic: Anthropic | null;
  private readonly defaultProvider: PaidAiProvider;
  private readonly mockAllowed: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject(AiBudgetService) private readonly budget: AiBudgetPort,
  ) {
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = openaiKey
      ? new OpenAI({ apiKey: openaiKey, maxRetries: 0 })
      : null;
    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    this.anthropic = anthropicKey
      ? new Anthropic({ apiKey: anthropicKey, maxRetries: 0 })
      : null;
    this.defaultProvider =
      this.configService.get<PaidAiProvider>('DEFAULT_LLM_PROVIDER') || 'openai';
    const environment = this.configService.get<string>('NODE_ENV');
    this.mockAllowed =
      environment === 'local' ||
      environment === 'development' ||
      environment === 'test';
  }

  async generateEmbedding(
    text: string,
    options?: Pick<LlmOptions, 'userId'>,
  ): Promise<number[]> {
    const client = this.openai;
    if (!client) {
      this.assertMockAllowed();
      return Array.from({ length: 1536 }, () => 0.1);
    }
    const model = 'text-embedding-3-small';
    const { response } = await this.attempt(
      {
        userId: this.requireUserId(options?.userId),
        provider: 'openai',
        model,
        operation: 'embedding',
      },
      () =>
        client.embeddings.create({ model, input: text }, { maxRetries: 0 }),
      (value) => openaiUsage(record(value)?.usage, 'embedding'),
    );
    const data = record(response)?.data;
    const embedding = Array.isArray(data) ? record(data[0])?.embedding : null;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    ) {
      throw providerFailure();
    }
    return [...embedding];
  }

  async generateResponse(
    messages: readonly LlmMessage[],
    options?: LlmOptions,
  ): Promise<LlmResponse> {
    const provider = options?.provider || this.defaultProvider;
    if (provider === 'openai') {
      if (!this.openai) return this.mockResponse(provider, messages);
      return this.openaiResponse(messages, this.requireUserId(options?.userId));
    }
    if (provider === 'anthropic') {
      if (!this.anthropic) return this.mockResponse(provider, messages);
      return this.anthropicResponse(
        messages,
        this.requireUserId(options?.userId),
      );
    }
    throw new ServiceUnavailableException({
      code: 'AI_PROVIDER_UNAVAILABLE',
      state: 'unavailable',
    });
  }

  private async openaiResponse(
    messages: readonly LlmMessage[],
    userId: string,
  ): Promise<LlmResponse> {
    const model = 'gpt-4o-mini';
    const client = this.openai!;
    const { response, usage, accounting } = await this.attempt(
      { userId, provider: 'openai', model, operation: 'chat' },
      (reservation) =>
        client.chat.completions.create(
          {
            model,
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            max_tokens: reservation.maxOutputTokens,
          },
          { maxRetries: 0 },
        ),
      (value) => openaiUsage(record(value)?.usage, 'chat'),
    );
    const choices = record(response)?.choices;
    const message = Array.isArray(choices) ? record(choices[0])?.message : null;
    const content = record(message)?.content;
    return {
      content: typeof content === 'string' ? content : '',
      usage: legacyUsage(usage),
      provider: 'openai',
      model,
      accounting,
    };
  }

  private async anthropicResponse(
    messages: readonly LlmMessage[],
    userId: string,
  ): Promise<LlmResponse> {
    const model = 'claude-3-haiku-20240307';
    const client = this.anthropic!;
    const system = messages.find((message) => message.role === 'system')?.content;
    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role:
          message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: message.content,
      }));
    const { response, usage, accounting } = await this.attempt(
      { userId, provider: 'anthropic', model, operation: 'chat' },
      (reservation) =>
        client.messages.create(
          {
            model,
            max_tokens: reservation.maxOutputTokens,
            system,
            messages: conversation,
          },
          { maxRetries: 0 },
        ),
      (value) => anthropicUsage(record(value)?.usage),
    );
    const blocks = record(response)?.content;
    const block = Array.isArray(blocks) ? record(blocks[0]) : null;
    return {
      content:
        block?.type === 'text' && typeof block.text === 'string' ? block.text : '',
      usage: legacyUsage(usage),
      provider: 'anthropic',
      model,
      accounting,
    };
  }

  private async attempt<T>(
    request: AiBudgetRequest,
    dispatch: (reservation: AiBudgetReservation) => Promise<T>,
    readUsage: (response: T) => AiBudgetUsage | null,
  ): Promise<{
    readonly response: T;
    readonly usage: AiBudgetUsage | null;
    readonly accounting: AiBudgetAccounting;
  }> {
    // Admission uses verified model ceilings selected by the store; no client
    // estimate, prompt or price crosses the budget port. Network work is outside it.
    const reservation = await this.budget.reserve(request);
    const start = Date.now();
    let response: T;
    try {
      response = await dispatch(reservation);
    } catch {
      await this.budget.reconcile(
        reservation.id,
        'provider_error',
        null,
        Math.max(0, Date.now() - start),
      );
      throw providerFailure();
    }
    let usage: AiBudgetUsage | null;
    try {
      usage = readUsage(response);
    } catch {
      // Unreadable usage is explicit uncertainty, retaining the durable charge.
      usage = null;
    }
    // Keep reconciliation outside the dispatch catch: budget/persistence failures
    // propagate once and can never turn into another provider call or fallback.
    const accounting = await this.budget.reconcile(
      reservation.id,
      usage ? 'success' : 'usage_missing',
      usage,
      Math.max(0, Date.now() - start),
    );
    return { response, usage, accounting };
  }

  private requireUserId(userId: string | undefined): string {
    if (typeof userId !== 'string' || !userId.trim()) {
      throw new UnauthorizedException({
        code: 'AI_AUTHENTICATION_REQUIRED',
        state: 'unavailable',
      });
    }
    return userId;
  }

  private assertMockAllowed(): void {
    if (!this.mockAllowed) {
      throw new ServiceUnavailableException({
        code: 'AI_PROVIDER_UNAVAILABLE',
        state: 'unavailable',
      });
    }
  }

  private mockResponse(
    provider: PaidAiProvider,
    messages: readonly LlmMessage[],
  ): LlmResponse {
    this.assertMockAllowed();
    return {
      content: `This is a mock response from the AI Assistant because the API keys for ${provider} are not configured. You said: ${messages[messages.length - 1]?.content}`,
      usage: null,
      provider: 'mock',
      model: 'mock-model',
      accounting: null,
    };
  }
}
