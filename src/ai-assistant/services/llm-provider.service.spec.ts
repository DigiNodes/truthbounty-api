import {
  BadGatewayException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { LlmProviderService } from './llm-provider.service';
import {
  AiBudgetAccounting,
  AiBudgetPort,
  AiBudgetReservation,
} from '../budgets/ai-budget.types';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const USER_ID = '22222222-2222-4222-8222-222222222222';
const PRICE_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGES = [
  { role: 'system' as const, content: 'Use verified protocol information.' },
  { role: 'user' as const, content: 'How do contributions work?' },
];
const RESERVATION: AiBudgetReservation = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-4o-mini',
  priceVersion: PRICE_ID,
  maxInputTokens: 128000,
  maxOutputTokens: 16384,
};
const SETTLED: AiBudgetAccounting = {
  state: 'settled',
  actualTokens: 30,
  chargedTokens: '30',
  chargedSpendUsdNanos: '80000',
  priceVersion: PRICE_ID,
};
const HELD: AiBudgetAccounting = {
  state: 'held',
  actualTokens: null,
  chargedTokens: '144384',
  chargedSpendUsdNanos: '100000000',
  priceVersion: PRICE_ID,
};

describe('LlmProviderService durable admission', () => {
  const openaiChat = jest.fn();
  const openaiEmbedding = jest.fn();
  const anthropicChat = jest.fn();
  const budget: AiBudgetPort = {
    reserve: jest.fn(),
    reconcile: jest.fn(),
    getUserUsage: jest.fn(),
    withAuthority: jest.fn(),
  };
  const reserve = budget.reserve as jest.Mock;
  const reconcile = budget.reconcile as jest.Mock;

  function service(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      NODE_ENV: 'production',
      DEFAULT_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'unit-test-placeholder',
      ANTHROPIC_API_KEY: 'unit-test-placeholder',
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    return new LlmProviderService(config, budget);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create: openaiChat } },
      embeddings: { create: openaiEmbedding },
    }));
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { create: anthropicChat },
    }));
    reserve.mockResolvedValue(RESERVATION);
    reconcile.mockResolvedValue(SETTLED);
    openaiChat.mockResolvedValue({
      choices: [{ message: { content: 'Verified response' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    openaiEmbedding.mockResolvedValue({
      data: [{ embedding: [0.2, 0.4] }],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
    anthropicChat.mockResolvedValue({
      content: [{ type: 'text', text: 'Anthropic response' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it.each(['chat', 'embedding'] as const)(
    'requires an authenticated owner before paid %s admission',
    async (operation) => {
      const provider = service();
      const call =
        operation === 'chat'
          ? provider.generateResponse(MESSAGES)
          : provider.generateEmbedding('protocol facts');
      await expect(call).rejects.toBeInstanceOf(UnauthorizedException);
      expect(reserve).not.toHaveBeenCalled();
      expect(openaiChat).not.toHaveBeenCalled();
      expect(openaiEmbedding).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each(['openai', 'anthropic', 'embedding'] as const)(
    'a denied %s admission makes zero SDK calls and keeps the budget error',
    async (operation) => {
      const denial = new ServiceUnavailableException({
        code: 'AI_BUDGET_UNAVAILABLE',
        state: 'unavailable',
      });
      reserve.mockRejectedValueOnce(denial);
      const provider = service();
      const call =
        operation === 'embedding'
          ? provider.generateEmbedding('protocol facts', { userId: USER_ID })
          : provider.generateResponse(MESSAGES, {
              userId: USER_ID,
              provider: operation,
            });
      await expect(call).rejects.toBe(denial);
      expect(openaiChat).not.toHaveBeenCalled();
      expect(openaiEmbedding).not.toHaveBeenCalled();
      expect(anthropicChat).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it('reserves only server-selected owner, provider, model and operation before one OpenAI call', async () => {
    const events: string[] = [];
    reserve.mockImplementationOnce(async () => {
      events.push('reserve');
      return RESERVATION;
    });
    openaiChat.mockImplementationOnce(async () => {
      events.push('dispatch');
      return {
        choices: [{ message: { content: 'Verified response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };
    });
    reconcile.mockImplementationOnce(async () => {
      events.push('reconcile');
      return SETTLED;
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
    });
    expect(reserve).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
    });
    expect(events).toEqual(['reserve', 'dispatch', 'reconcile']);
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'unit-test-placeholder',
      maxRetries: 0,
    });
    expect(openaiChat).toHaveBeenCalledTimes(1);
    expect(openaiChat).toHaveBeenCalledWith(
      { model: 'gpt-4o-mini', messages: MESSAGES, max_tokens: 16384 },
      { maxRetries: 0 },
    );
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'success',
      { inputTokens: 10, outputTokens: 20 },
      expect.any(Number),
    );
    expect(result).toEqual({
      content: 'Verified response',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      provider: 'openai',
      model: 'gpt-4o-mini',
      accounting: SETTLED,
    });
  });

  it('uses the reservation output cap rather than any caller token estimate', async () => {
    reserve.mockResolvedValueOnce({ ...RESERVATION, maxOutputTokens: 77 });
    await service().generateResponse(MESSAGES, { userId: USER_ID });
    expect(openaiChat.mock.calls[0][0].max_tokens).toBe(77);
    expect(Object.keys(reserve.mock.calls[0][0]).sort()).toEqual([
      'model',
      'operation',
      'provider',
      'userId',
    ]);
  });

  it('preserves Anthropic model, system prompt and 1024 output policy without SDK retries', async () => {
    reserve.mockResolvedValueOnce({
      ...RESERVATION,
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      maxInputTokens: 200000,
      maxOutputTokens: 1024,
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
      provider: 'anthropic',
    });
    expect(reserve).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      operation: 'chat',
    });
    expect(Anthropic).toHaveBeenCalledWith({
      apiKey: 'unit-test-placeholder',
      maxRetries: 0,
    });
    expect(anthropicChat).toHaveBeenCalledTimes(1);
    expect(anthropicChat).toHaveBeenCalledWith(
      {
        model: 'claude-3-haiku-20240307',
        max_tokens: 1024,
        system: MESSAGES[0].content,
        messages: [{ role: 'user', content: MESSAGES[1].content }],
      },
      { maxRetries: 0 },
    );
    expect(result.model).toBe('claude-3-haiku-20240307');
    expect(openaiChat).not.toHaveBeenCalled();
  });

  it('admits and reconciles one embedding call with no output tokens', async () => {
    reserve.mockResolvedValueOnce({
      ...RESERVATION,
      model: 'text-embedding-3-small',
      maxInputTokens: 8192,
      maxOutputTokens: 0,
    });
    const result = await service().generateEmbedding('protocol facts', {
      userId: USER_ID,
    });
    expect(reserve).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: 'openai',
      model: 'text-embedding-3-small',
      operation: 'embedding',
    });
    expect(openaiEmbedding).toHaveBeenCalledTimes(1);
    expect(openaiEmbedding).toHaveBeenCalledWith(
      { model: 'text-embedding-3-small', input: 'protocol facts' },
      { maxRetries: 0 },
    );
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'success',
      { inputTokens: 7, outputTokens: 0 },
      expect.any(Number),
    );
    expect(result).toEqual([0.2, 0.4]);
  });

  it('passes verified cached OpenAI input counts for immutable-price accounting', async () => {
    openaiChat.mockResolvedValueOnce({
      choices: [{ message: { content: 'Cached answer' } }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 2,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    await service().generateResponse(MESSAGES, { userId: USER_ID });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'success',
      { inputTokens: 8, outputTokens: 2, cachedInputTokens: 3 },
      expect.any(Number),
    );
  });

  it('counts Anthropic cache reads in total input without counting them twice', async () => {
    anthropicChat.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Cached answer' }],
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
      provider: 'anthropic',
    });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'success',
      { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
      expect.any(Number),
    );
    expect(result.usage?.total_tokens).toBe(15);
  });

  it.each([
    undefined,
    { prompt_tokens: 10 },
    { prompt_tokens: '10', completion_tokens: 20 },
    { prompt_tokens: -1, completion_tokens: 20 },
    { prompt_tokens: 1.5, completion_tokens: 20 },
    { prompt_tokens: Number.NaN, completion_tokens: 20 },
    { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 20 },
    { prompt_tokens: 10, completion_tokens: 20, total_tokens: 99 },
    {
      prompt_tokens: 10,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 11 },
    },
  ])('keeps missing or invalid OpenAI usage unknown (%j)', async (usage) => {
    reconcile.mockResolvedValueOnce(HELD);
    openaiChat.mockResolvedValueOnce({
      choices: [{ message: { content: 'Output with uncertain usage' } }],
      usage,
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
    });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'usage_missing',
      null,
      expect.any(Number),
    );
    expect(result.content).toBe('Output with uncertain usage');
    expect(result.usage).toBeNull();
    expect(result.accounting).toEqual(HELD);
  });

  it.each([
    { input_tokens: 10 },
    { input_tokens: '10', output_tokens: 2 },
    { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: -1 },
    { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 1 },
  ])('holds incomplete or unsupported Anthropic usage (%j)', async (usage) => {
    reconcile.mockResolvedValueOnce(HELD);
    anthropicChat.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Output with uncertain usage' }],
      usage,
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
      provider: 'anthropic',
    });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'usage_missing',
      null,
      expect.any(Number),
    );
    expect(result.usage).toBeNull();
    expect(result.accounting?.actualTokens).toBeNull();
  });

  it('keeps embedding usage unknown when only an unverified total is returned', async () => {
    reconcile.mockResolvedValueOnce(HELD);
    openaiEmbedding.mockResolvedValueOnce({
      data: [{ embedding: [0.2, 0.4] }],
      usage: { total_tokens: 7 },
    });
    await service().generateEmbedding('protocol facts', { userId: USER_ID });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'usage_missing',
      null,
      expect.any(Number),
    );
  });

  it.each(['openai', 'anthropic', 'embedding'] as const)(
    'awaits reconciliation before parsing %s output',
    async (operation) => {
      let complete!: (accounting: AiBudgetAccounting) => void;
      let entered!: () => void;
      const enteredReconciliation = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<AiBudgetAccounting>((resolve) => {
        complete = resolve;
      });
      reconcile.mockImplementationOnce(() => {
        entered();
        return pending;
      });
      const outputRead = jest.fn(() =>
        operation === 'embedding'
          ? [{ embedding: [0.2, 0.4] }]
          : operation === 'anthropic'
            ? [{ type: 'text', text: 'Reconciled answer' }]
            : [{ message: { content: 'Reconciled answer' } }],
      );
      const rawResponse = {
        usage:
          operation === 'anthropic'
            ? { input_tokens: 10, output_tokens: 20 }
            : operation === 'embedding'
              ? { prompt_tokens: 7, total_tokens: 7 }
              : { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        get choices() {
          return outputRead();
        },
        get content() {
          return outputRead();
        },
        get data() {
          return outputRead();
        },
      };
      const sdk =
        operation === 'anthropic'
          ? anthropicChat
          : operation === 'embedding'
            ? openaiEmbedding
            : openaiChat;
      sdk.mockResolvedValueOnce(rawResponse);
      const provider = service();
      const result =
        operation === 'embedding'
          ? provider.generateEmbedding('protocol facts', { userId: USER_ID })
          : provider.generateResponse(MESSAGES, {
              userId: USER_ID,
              provider: operation,
            });
      await enteredReconciliation;
      expect(outputRead).not.toHaveBeenCalled();
      complete(SETTLED);
      await result;
      expect(outputRead).toHaveBeenCalledTimes(1);
      expect(sdk).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['openai', 'anthropic', 'embedding'] as const)(
    'reconciles %s provider errors conservatively without fallback or raw errors',
    async (operation) => {
      const sdk =
        operation === 'anthropic'
          ? anthropicChat
          : operation === 'embedding'
            ? openaiEmbedding
            : openaiChat;
      sdk.mockRejectedValueOnce(new Error('private prompt and provider details'));
      reconcile.mockResolvedValueOnce(HELD);
      const provider = service();
      const call =
        operation === 'embedding'
          ? provider.generateEmbedding('protocol facts', { userId: USER_ID })
          : provider.generateResponse(MESSAGES, {
              userId: USER_ID,
              provider: operation,
            });
      await expect(call).rejects.toBeInstanceOf(BadGatewayException);
      await expect(call).rejects.not.toThrow('private prompt');
      expect(reconcile).toHaveBeenCalledWith(
        RESERVATION.id,
        'provider_error',
        null,
        expect.any(Number),
      );
      expect(sdk).toHaveBeenCalledTimes(1);
      expect(
        openaiChat.mock.calls.length +
          anthropicChat.mock.calls.length +
          openaiEmbedding.mock.calls.length,
      ).toBe(1);
    },
  );

  it.each(['success', 'provider_error'] as const)(
    'a %s accounting failure propagates without another dispatch or reconciliation',
    async (outcome) => {
      const failure = new ServiceUnavailableException('Accounting unavailable');
      reconcile.mockRejectedValueOnce(failure);
      if (outcome === 'provider_error') {
        openaiChat.mockRejectedValueOnce(new Error('upstream unavailable'));
      }
      await expect(
        service().generateResponse(MESSAGES, { userId: USER_ID }),
      ).rejects.toBe(failure);
      expect(openaiChat).toHaveBeenCalledTimes(1);
      expect(anthropicChat).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledTimes(1);
    },
  );

  it('passes actual usage above the bound without clipping violation evidence', async () => {
    const violated: AiBudgetAccounting = {
      state: 'violated',
      actualTokens: 144386,
      chargedTokens: '144386',
      chargedSpendUsdNanos: '100000001',
      priceVersion: PRICE_ID,
    };
    reconcile.mockResolvedValueOnce(violated);
    openaiChat.mockResolvedValueOnce({
      choices: [{ message: { content: 'Response requiring an operator review' } }],
      usage: {
        prompt_tokens: 128001,
        completion_tokens: 16385,
        total_tokens: 144386,
      },
    });
    const result = await service().generateResponse(MESSAGES, { userId: USER_ID });
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'success',
      { inputTokens: 128001, outputTokens: 16385 },
      expect.any(Number),
    );
    expect(result.accounting).toEqual(violated);
    expect(openaiChat).toHaveBeenCalledTimes(1);
  });

  it('retains a hold when successful response usage cannot be read', async () => {
    reconcile.mockResolvedValueOnce(HELD);
    openaiChat.mockResolvedValueOnce({
      choices: [{ message: { content: 'Response with unreadable usage' } }],
      get usage() {
        throw new Error('unreadable provider usage');
      },
    });
    const result = await service().generateResponse(MESSAGES, { userId: USER_ID });
    expect(result.content).toBe('Response with unreadable usage');
    expect(result.usage).toBeNull();
    expect(reconcile).toHaveBeenCalledWith(
      RESERVATION.id,
      'usage_missing',
      null,
      expect.any(Number),
    );
  });

  it('retains successful usage even when the chat has no content to parse', async () => {
    openaiChat.mockResolvedValueOnce({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    const result = await service().generateResponse(MESSAGES, {
      userId: USER_ID,
    });
    expect(result.content).toBe('');
    expect(result.accounting).toEqual(SETTLED);
    expect(reconcile.mock.calls[0][1]).toBe('success');
    expect(openaiChat).toHaveBeenCalledTimes(1);
  });

  it('reconciles successful embeddings before rejecting malformed output', async () => {
    openaiEmbedding.mockResolvedValueOnce({
      data: [],
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
    await expect(
      service().generateEmbedding('protocol facts', { userId: USER_ID }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(reconcile.mock.calls[0][1]).toBe('success');
    expect(openaiEmbedding).toHaveBeenCalledTimes(1);
  });

  it.each(['staging', 'production', 'unknown'])(
    'missing paid keys in %s never become mock success',
    async (environment) => {
      const provider = service({
        NODE_ENV: environment,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      });
      await expect(
        provider.generateResponse(MESSAGES, { userId: USER_ID }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        provider.generateEmbedding('protocol facts', { userId: USER_ID }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(reserve).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(openaiChat).not.toHaveBeenCalled();
      expect(openaiEmbedding).not.toHaveBeenCalled();
    },
  );

  it('does not switch a selected unconfigured Anthropic provider to OpenAI', async () => {
    const provider = service({ ANTHROPIC_API_KEY: undefined });
    await expect(
      provider.generateResponse(MESSAGES, {
        userId: USER_ID,
        provider: 'anthropic',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(openaiChat).not.toHaveBeenCalled();
    expect(anthropicChat).not.toHaveBeenCalled();
  });

  it.each(['local', 'development', 'test'])(
    'keeps explicit %s mocks outside paid admission without fabricated usage',
    async (environment) => {
      const provider = service({
        NODE_ENV: environment,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      });
      const result = await provider.generateResponse(MESSAGES);
      expect(result.provider).toBe('mock');
      expect(result.usage).toBeNull();
      expect(result.accounting).toBeNull();
      expect(await provider.generateEmbedding('protocol facts')).toHaveLength(
        1536,
      );
      expect(reserve).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );
});
