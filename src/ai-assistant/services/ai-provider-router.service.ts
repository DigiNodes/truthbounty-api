import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiChatRequest,
  AiChatResponse,
  AiProvider,
} from '../providers/ai-provider.interface';
import { OpenAiProvider } from '../providers/openai.provider';
import { MockProvider } from '../providers/mock.provider';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import {
  AiEndpointLabel,
  AiMetricsService,
} from '../metrics/ai-metrics.service';
import { AiConfig } from '../config/ai.config';
import { AppUserRole } from '../../auth/decorators/roles.decorator';
import {
  ConfiguredAiProvider,
  mockProviderAllowed,
  redactSecrets,
} from '../../config/ai-provider';

export type AiProviderName = Extract<ConfiguredAiProvider, 'openai' | 'mock'>;

const isRoutableProvider = (provider: unknown): provider is AiProviderName =>
  provider === 'openai' || provider === 'mock';

export interface RoutedProvider {
  provider: AiProvider;
  fallback: boolean;
}

export interface RoutedChatResult {
  response: AiChatResponse;
  provider: string;
  fallback: boolean;
}

/**
 * Sole consumer of AiProvider implementations. Resolves which provider a
 * request should use (configured default, or an admin-only per-request
 * override), and falls back to the other provider when the resolved one is
 * unavailable or throws.
 */
@Injectable()
export class AiProviderRouterService {
  private readonly logger = new Logger(AiProviderRouterService.name);
  private readonly providers: Record<AiProviderName, AiProvider>;
  private readonly aiConfig: AiConfig;
  private readonly mockAllowed: boolean;
  private readonly secrets: readonly (string | undefined)[];

  constructor(
    private readonly openAiProvider: OpenAiProvider,
    private readonly mockProvider: MockProvider,
    private readonly cache: AiAssistantCache,
    private readonly metrics: AiMetricsService,
    private readonly configService: ConfigService,
  ) {
    this.providers = { openai: this.openAiProvider, mock: this.mockProvider };
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
    this.mockAllowed = mockProviderAllowed(
      this.configService.get<string>('NODE_ENV'),
      this.configService.get<string | boolean>('LOCAL_DEV_MODE'),
    );
    this.secrets = [this.configService.get<string>('OPENAI_API_KEY')];
  }

  private unavailable(detail: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: detail,
    });
  }

  private resolvePrimaryName(
    requesterRole?: AppUserRole,
    override?: AiProviderName,
  ): AiProviderName {
    if (!isRoutableProvider(this.aiConfig.provider))
      throw this.unavailable('Configured AI provider is not supported here.');
    if (override === 'mock' && !this.mockAllowed)
      throw new ForbiddenException('Mock provider is not available.');
    if (override && requesterRole === 'admin') return override;
    if (this.aiConfig.provider === 'mock' && !this.mockAllowed)
      throw this.unavailable('Configured AI provider is not available.');
    return this.aiConfig.provider;
  }

  private fallbackNameFor(name: AiProviderName): AiProviderName | undefined {
    if (name === 'mock') return 'openai';
    return this.mockAllowed ? 'mock' : undefined;
  }

  private async checkAvailability(name: AiProviderName): Promise<boolean> {
    const cached = await this.cache.getProviderAvailability(name);
    if (cached !== null) {
      return cached;
    }
    const available = await this.providers[name].isAvailable();
    await this.cache.setProviderAvailability(name, available);
    this.metrics.setProviderAvailability(name, available);
    return available;
  }

  async resolveForRequest(
    requesterRole?: AppUserRole,
    override?: AiProviderName,
  ): Promise<RoutedProvider> {
    const primaryName = this.resolvePrimaryName(requesterRole, override);
    const available = await this.checkAvailability(primaryName);
    if (available) {
      return { provider: this.providers[primaryName], fallback: false };
    }

    const fallbackName = this.fallbackNameFor(primaryName);
    if (!fallbackName)
      throw this.unavailable('Configured AI provider is unavailable.');
    this.logger.warn(
      `Provider "${primaryName}" unavailable, falling back to "${fallbackName}"`,
    );
    return { provider: this.providers[fallbackName], fallback: true };
  }

  async chat(
    request: AiChatRequest,
    endpoint: AiEndpointLabel,
    requesterRole?: AppUserRole,
    override?: AiProviderName,
  ): Promise<RoutedChatResult> {
    const { provider, fallback } = await this.resolveForRequest(
      requesterRole,
      override,
    );
    const start = Date.now();

    try {
      const response = await provider.chat(request);
      this.recordOutcome(
        provider.name,
        endpoint,
        fallback ? 'fallback' : 'success',
        response,
        start,
      );
      return { response, provider: provider.name, fallback };
    } catch (error) {
      const fallbackName = this.fallbackNameFor(provider.name as AiProviderName);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Provider "${provider.name}" chat() failed: ${redactSecrets(message, this.secrets)}`,
      );
      if (!fallbackName) {
        this.metrics.recordRequest(provider.name, endpoint, 'error');
        throw this.unavailable('Configured AI provider is unavailable.');
      }
      const fallbackProvider = this.providers[fallbackName];
      const fallbackStart = Date.now();
      try {
        const response = await fallbackProvider.chat(request);
        this.recordOutcome(
          fallbackProvider.name,
          endpoint,
          'fallback',
          response,
          fallbackStart,
        );
        return { response, provider: fallbackProvider.name, fallback: true };
      } catch (fallbackError) {
        this.metrics.recordRequest(provider.name, endpoint, 'error');
        throw fallbackError;
      }
    }
  }

  private recordOutcome(
    providerName: string,
    endpoint: AiEndpointLabel,
    status: 'success' | 'fallback',
    response: AiChatResponse,
    startedAt: number,
  ): void {
    this.metrics.recordRequest(providerName, endpoint, status);
    this.metrics.observeLatency(
      providerName,
      endpoint,
      (Date.now() - startedAt) / 1000,
    );
    this.metrics.recordTokens(providerName, 'prompt', response.promptTokens);
    this.metrics.recordTokens(
      providerName,
      'completion',
      response.completionTokens,
    );
  }
}
