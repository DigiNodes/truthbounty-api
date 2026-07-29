import { firstValueFrom, toArray } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { OpenAiProvider } from './openai.provider';
import { AiChatRequest } from './ai-provider.interface';

const mockCreate = jest.fn();
const mockModelsList = jest.fn();

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
      models: { list: mockModelsList },
    })),
  };
});

describe('OpenAiProvider', () => {
  let provider: OpenAiProvider;
  const request: AiChatRequest = {
    messages: [{ role: 'user', content: 'hello' }],
    userId: 'user-1',
    requestId: 'req-1',
  };

  const buildConfigService = () =>
    ({
      get: jest.fn().mockReturnValue({
        provider: 'openai',
        openai: {
          apiKey: 'sk-test',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
        },
      }),
    }) as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OpenAiProvider(buildConfigService());
  });

  it('maps a non-streaming chat completion to AiChatResponse', async () => {
    mockCreate.mockResolvedValue({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const response = await provider.chat(request);

    expect(response).toEqual({
      content: 'Hi there',
      model: 'gpt-4o-mini',
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      finishReason: 'stop',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
  });

  it('maps streamed chunks to AiStreamChunk, marking the terminal chunk done', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hi ' }, finish_reason: null }] };
      yield {
        choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      };
    }
    mockCreate.mockResolvedValue(fakeStream());

    const chunks = await firstValueFrom(
      provider.stream(request).pipe(toArray()),
    );

    expect(chunks).toEqual([
      { delta: 'Hi ', done: false, finishReason: undefined, usage: undefined },
      {
        delta: 'there',
        done: true,
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      },
    ]);
  });

  it('isAvailable() returns true when the provider responds', async () => {
    mockModelsList.mockResolvedValue({ data: [] });
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('isAvailable() returns false when the provider call throws', async () => {
    mockModelsList.mockRejectedValue(new Error('network error'));
    await expect(provider.isAvailable()).resolves.toBe(false);
  });
});
