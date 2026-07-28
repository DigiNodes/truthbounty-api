import { ConfigService } from '@nestjs/config';
import { AiProviderRouterService } from './ai-provider-router.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiMetricsService } from '../metrics/ai-metrics.service';
import {
  AiChatRequest,
  AiChatResponse,
} from '../providers/ai-provider.interface';

describe('AiProviderRouterService', () => {
  let router: AiProviderRouterService;
  let openAiProvider: any;
  let mockProvider: any;
  let cache: jest.Mocked<
    Pick<
      AiAssistantCache,
      'getProviderAvailability' | 'setProviderAvailability'
    >
  >;
  let metrics: jest.Mocked<
    Pick<
      AiMetricsService,
      | 'setProviderAvailability'
      | 'recordRequest'
      | 'observeLatency'
      | 'recordTokens'
    >
  >;

  const request: AiChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    userId: 'user-1',
    requestId: 'req-1',
  };

  const chatResponse: AiChatResponse = {
    content: 'hello',
    model: 'test-model',
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
    finishReason: 'stop',
  };

  beforeEach(() => {
    openAiProvider = {
      name: 'openai',
      chat: jest.fn(),
      stream: jest.fn(),
      isAvailable: jest.fn(),
    };
    mockProvider = {
      name: 'mock',
      chat: jest.fn(),
      stream: jest.fn(),
      isAvailable: jest.fn(),
    };
    cache = {
      getProviderAvailability: jest.fn().mockResolvedValue(null),
      setProviderAvailability: jest.fn(),
    };
    metrics = {
      setProviderAvailability: jest.fn(),
      recordRequest: jest.fn(),
      observeLatency: jest.fn(),
      recordTokens: jest.fn(),
    };
    const configService = {
      get: jest.fn().mockReturnValue({ provider: 'mock' }),
    } as unknown as ConfigService;

    router = new AiProviderRouterService(
      openAiProvider,
      mockProvider,
      cache as unknown as AiAssistantCache,
      metrics as unknown as AiMetricsService,
      configService,
    );
  });

  it('uses the configured default provider when it is available', async () => {
    mockProvider.isAvailable.mockResolvedValue(true);
    mockProvider.chat.mockResolvedValue(chatResponse);

    const result = await router.chat(request, 'chat');

    expect(result).toEqual({
      response: chatResponse,
      provider: 'mock',
      fallback: false,
    });
    expect(metrics.recordRequest).toHaveBeenCalledWith(
      'mock',
      'chat',
      'success',
    );
  });

  it('falls back to the other provider when the primary reports unavailable', async () => {
    mockProvider.isAvailable.mockResolvedValue(false);
    openAiProvider.chat.mockResolvedValue(chatResponse);

    const result = await router.chat(request, 'chat');

    expect(result).toEqual({
      response: chatResponse,
      provider: 'openai',
      fallback: true,
    });
    expect(metrics.recordRequest).toHaveBeenCalledWith(
      'openai',
      'chat',
      'fallback',
    );
  });

  it('falls back to the other provider when the primary throws mid-call', async () => {
    mockProvider.isAvailable.mockResolvedValue(true);
    mockProvider.chat.mockRejectedValue(new Error('boom'));
    openAiProvider.chat.mockResolvedValue(chatResponse);

    const result = await router.chat(request, 'chat');

    expect(result).toEqual({
      response: chatResponse,
      provider: 'openai',
      fallback: true,
    });
  });

  it('records an error and rethrows when both providers fail', async () => {
    mockProvider.isAvailable.mockResolvedValue(true);
    mockProvider.chat.mockRejectedValue(new Error('primary down'));
    openAiProvider.chat.mockRejectedValue(new Error('fallback down'));

    await expect(router.chat(request, 'chat')).rejects.toThrow('fallback down');
    expect(metrics.recordRequest).toHaveBeenCalledWith('mock', 'chat', 'error');
  });

  it('honors an admin-only provider override', async () => {
    openAiProvider.isAvailable.mockResolvedValue(true);
    openAiProvider.chat.mockResolvedValue(chatResponse);

    const result = await router.chat(request, 'chat', 'admin', 'openai');

    expect(result.provider).toBe('openai');
  });

  it('ignores a provider override from a non-admin role', async () => {
    mockProvider.isAvailable.mockResolvedValue(true);
    mockProvider.chat.mockResolvedValue(chatResponse);

    const result = await router.chat(request, 'chat', 'contributor', 'openai');

    expect(result.provider).toBe('mock');
  });

  it('caches provider availability checks instead of probing every request', async () => {
    cache.getProviderAvailability.mockResolvedValue(true);
    mockProvider.chat.mockResolvedValue(chatResponse);

    await router.chat(request, 'chat');

    expect(mockProvider.isAvailable).not.toHaveBeenCalled();
  });
});
