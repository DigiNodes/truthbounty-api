import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  ConfiguredAiProvider,
  isDeployedEnvironment,
  isRealAiProvider,
  mockProviderAllowed,
  normalizeAiProvider,
  providerSecretKey,
  redactSecrets,
} from '../../config/ai-provider';

export interface LlmResponse {
  content: string;
  usage: any;
  provider: ConfiguredAiProvider;
  model: string;
}

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;
  private readonly defaultProvider: ConfiguredAiProvider;
  private readonly deployed: boolean;
  private readonly mockAllowed: boolean;
  private readonly secrets: readonly (string | undefined)[];

  constructor(private configService: ConfigService) {
    const openaiKey = this.readSecret('OPENAI_API_KEY');
    const anthropicKey = this.readSecret('ANTHROPIC_API_KEY');
    this.secrets = [openaiKey, anthropicKey];
    if (openaiKey) this.openai = new OpenAI({ apiKey: openaiKey });
    if (anthropicKey) this.anthropic = new Anthropic({ apiKey: anthropicKey });

    this.deployed = isDeployedEnvironment(
      this.configService.get<string>('NODE_ENV'),
    );
    this.mockAllowed = mockProviderAllowed(
      this.configService.get<string>('NODE_ENV'),
      this.configService.get<string | boolean>('LOCAL_DEV_MODE'),
    );
    this.defaultProvider =
      normalizeAiProvider(
        this.configService.get<string>('DEFAULT_LLM_PROVIDER') ??
          this.configService.get<string>('AI_PROVIDER'),
      ) ?? 'openai';

    if (this.deployed) {
      if (!isRealAiProvider(this.defaultProvider))
        throw this.unavailable('Configured AI provider is not available.');
      if (!this.clientFor(this.defaultProvider))
        throw this.unavailable('Configured AI provider is not available.');
    }
  }

  private readSecret(
    key: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY',
  ): string | undefined {
    const raw = this.configService.get<string>(key);
    const value = typeof raw === 'string' ? raw.trim() : undefined;
    return value || undefined;
  }

  private clientFor(provider: ConfiguredAiProvider): OpenAI | Anthropic | null {
    if (provider === 'openai') return this.openai;
    if (provider === 'anthropic') return this.anthropic;
    return null;
  }

  private unavailable(detail: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: detail,
    });
  }

  private logProviderError(provider: ConfiguredAiProvider, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `AI provider "${provider}" failed: ${redactSecrets(message, this.secrets)}`,
    );
  }

  private mockResponse(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  ): LlmResponse {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const suffix = lastUser ? ` User said: ${lastUser.content}` : '';
    return {
      content: `Mock provider output. This is not a real model response.${suffix}`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      provider: 'mock',
      model: 'mock-model',
    };
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.openai)
      throw this.unavailable('OpenAI embeddings are not configured.');
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      this.logProviderError('openai', error);
      throw this.unavailable('OpenAI embeddings are unavailable.');
    }
  }

  async generateResponse(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    options?: { provider?: ConfiguredAiProvider },
  ): Promise<LlmResponse> {
    const provider = options?.provider ?? this.defaultProvider;

    if (provider === 'mock') {
      if (!this.mockAllowed)
        throw this.unavailable('Mock provider is not available.');
      return this.mockResponse(messages);
    }

    const client = this.clientFor(provider);
    if (!client) throw this.unavailable('Configured AI provider is not available.');

    try {
      if (provider === 'openai') {
        const model = 'gpt-4o-mini';
        const response = await (client as OpenAI).chat.completions.create({
          model,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        return {
          content: response.choices[0]?.message?.content ?? '',
          usage: response.usage,
          provider: 'openai',
          model: response.model || model,
        };
      }

      const model = 'claude-3-haiku-20240307';
      const systemMessage = messages.find((message) => message.role === 'system')?.content;
      const response = await (client as Anthropic).messages.create({
        model,
        max_tokens: 1024,
        system: systemMessage,
        messages: messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: message.content,
          })),
      });
      const firstContent = response.content[0];
      return {
        content: firstContent?.type === 'text' ? firstContent.text : '',
        usage: {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
        provider: 'anthropic',
        model: response.model || model,
      };
    } catch (error) {
      this.logProviderError(provider, error);
      throw this.unavailable('Configured AI provider is unavailable.');
    }
  }
}
