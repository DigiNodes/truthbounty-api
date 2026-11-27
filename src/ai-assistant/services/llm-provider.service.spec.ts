import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProviderService } from './llm-provider.service';

const configService = (values: Record<string, unknown>): ConfigService =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ConfigService;

describe('LlmProviderService', () => {
  const messages = [{ role: 'user' as const, content: 'hello' }];

  it('fails at startup in deployed environments when the selected provider has no key', () => {
    expect(
      () =>
        new LlmProviderService(
          configService({
            NODE_ENV: 'production',
            DEFAULT_LLM_PROVIDER: 'openai',
          }),
        ),
    ).toThrow(ServiceUnavailableException);
    expect(
      () =>
        new LlmProviderService(
          configService({
            NODE_ENV: 'staging',
            DEFAULT_LLM_PROVIDER: 'anthropic',
          }),
        ),
    ).toThrow(ServiceUnavailableException);
  });

  it('fails at startup when a deployed environment selects mock', () => {
    expect(
      () =>
        new LlmProviderService(
          configService({
            NODE_ENV: 'production',
            DEFAULT_LLM_PROVIDER: 'mock',
            OPENAI_API_KEY: 'openai-credential',
          }),
        ),
    ).toThrow(ServiceUnavailableException);
  });

  it('reports the model returned by the real provider', async () => {
    const service = new LlmProviderService(
      configService({
        NODE_ENV: 'production',
        DEFAULT_LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-credential',
      }),
    );
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'real answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      model: 'gpt-4o-mini-2024-07-18',
    });
    (service as any).openai = { chat: { completions: { create } } };

    const response = await service.generateResponse(messages);

    expect(response).toMatchObject({
      content: 'real answer',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
    });
  });

  it('does not fabricate a mock fallback when the configured client is missing', async () => {
    const service = new LlmProviderService(
      configService({ NODE_ENV: 'test', DEFAULT_LLM_PROVIDER: 'openai' }),
    );
    await expect(service.generateResponse(messages)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.generateEmbedding('hello')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('returns explicitly labeled mock output only where mock is permitted', async () => {
    const service = new LlmProviderService(
      configService({ NODE_ENV: 'test', DEFAULT_LLM_PROVIDER: 'mock' }),
    );
    const response = await service.generateResponse(messages);
    expect(response.provider).toBe('mock');
    expect(response.model).toBe('mock-model');
    expect(response.content).toContain('not a real model response');

    const deployed = new LlmProviderService(
      configService({
        NODE_ENV: 'production',
        DEFAULT_LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'openai-credential',
      }),
    );
    await expect(
      deployed.generateResponse(messages, { provider: 'mock' }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('redacts configured credentials from provider errors', async () => {
    const key = 'sk-secret-credential-1234';
    const service = new LlmProviderService(
      configService({
        NODE_ENV: 'production',
        DEFAULT_LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: key,
      }),
    );
    (service as any).openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error(`auth failed for ${key}`)),
        },
      },
    };

    try {
      await service.generateResponse(messages);
      throw new Error('expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(JSON.stringify(error)).not.toContain(key);
    }
  });
});
