import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { AiAssistantService } from './ai-assistant.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiBudgetPort } from '../budgets/ai-budget.types';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const PRICE_ID = '33333333-3333-4333-8333-333333333333';

describe('active AiAssistantService budget integration', () => {
  const sdk = jest.fn();
  const prisma = {
    conversation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    message: { create: jest.fn(), findMany: jest.fn() },
    aiUsageMetric: { create: jest.fn() },
  };
  const budget: AiBudgetPort = {
    reserve: jest.fn(),
    reconcile: jest.fn(),
    getUserUsage: jest.fn(),
    withAuthority: jest.fn(),
  };
  const reserve = budget.reserve as jest.Mock;
  const reconcile = budget.reconcile as jest.Mock;
  const retrieval = jest.fn();
  const safety = { checkContent: jest.fn() };
  let provider: LlmProviderService;
  let assistant: AiAssistantService;

  beforeEach(() => {
    jest.resetAllMocks();
    (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
      chat: { completions: { create: sdk } },
      embeddings: { create: jest.fn() },
    }));
    (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
      messages: { create: jest.fn() },
    }));
    const configuration: Record<string, unknown> = {
      NODE_ENV: 'production',
      OPENAI_API_KEY: 'unit-test-placeholder',
      DEFAULT_LLM_PROVIDER: 'openai',
    };
    provider = new LlmProviderService(
      { get: (key: string) => configuration[key] } as unknown as ConfigService,
      budget,
    );
    assistant = new AiAssistantService(
      prisma as unknown as PrismaService,
      provider,
      { retrieveContext: retrieval } as unknown as RagService,
      safety as unknown as SafetyGuardrailService,
    );
    prisma.conversation.findUnique.mockResolvedValue({
      id: CONVERSATION_ID,
      userId: USER_ID,
    });
    prisma.conversation.update.mockResolvedValue({});
    prisma.message.create
      .mockResolvedValueOnce({ id: 'user-message' })
      .mockResolvedValue({ id: 'assistant-message', content: 'Verified answer' });
    prisma.message.findMany.mockResolvedValue([
      { role: 'user', content: 'How do contributions work?' },
    ]);
    retrieval.mockResolvedValue({
      context: 'Verified protocol context',
      citations: ['Guide'],
    });
    safety.checkContent.mockReturnValue({ flagged: false, blocked: false });
    reserve.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'openai',
      model: 'gpt-4o-mini',
      priceVersion: PRICE_ID,
      maxInputTokens: 128000,
      maxOutputTokens: 16384,
    });
    reconcile.mockResolvedValue({
      state: 'settled',
      actualTokens: 30,
      chargedTokens: '30',
      chargedSpendUsdNanos: '80000',
      priceVersion: PRICE_ID,
    });
    sdk.mockResolvedValue({
      choices: [{ message: { content: 'Verified answer' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  });

  it('passes the verified conversation owner and preserves prompt and history policy', async () => {
    const generate = jest.spyOn(provider, 'generateResponse');
    const result = await assistant.sendMessage(USER_ID, CONVERSATION_ID, {
      content: 'How do contributions work?',
    });
    expect(generate).toHaveBeenCalledWith(
      [
        {
          role: 'system',
          content: expect.stringContaining('Verified protocol context'),
        },
        { role: 'user', content: 'How do contributions work?' },
      ],
      { userId: USER_ID },
    );
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    expect(reserve.mock.calls[0][0].userId).toBe(USER_ID);
    expect(result.metadata).toEqual({
      provider: 'openai',
      latencyMs: expect.any(Number),
      tokens: 30,
      usageState: 'settled',
      chargedTokens: '30',
      chargedSpendUsdNanos: '80000',
      priceVersion: PRICE_ID,
      citations: ['Guide'],
    });
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('never creates a second usage writer on the active message path', async () => {
    await assistant.sendMessage(USER_ID, CONVERSATION_ID, {
      content: 'How do contributions work?',
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('returns truthful unknown token and held-charge metadata for partial provider usage', async () => {
    sdk.mockResolvedValueOnce({
      choices: [{ message: { content: 'Uncertain usage answer' } }],
      usage: { prompt_tokens: 10 },
    });
    reconcile.mockResolvedValueOnce({
      state: 'held',
      actualTokens: null,
      chargedTokens: '144384',
      chargedSpendUsdNanos: '100000000',
      priceVersion: PRICE_ID,
    });
    const result = await assistant.sendMessage(USER_ID, CONVERSATION_ID, {
      content: 'How do contributions work?',
    });
    expect(result.metadata).toEqual({
      provider: 'openai',
      latencyMs: expect.any(Number),
      tokens: null,
      usageState: 'held',
      chargedTokens: '144384',
      chargedSpendUsdNanos: '100000000',
      priceVersion: PRICE_ID,
      citations: ['Guide'],
    });
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('denial leaves only the pre-existing user-message write and makes no paid call', async () => {
    const failure = new Error('admission denied');
    reserve.mockRejectedValueOnce(failure);
    await expect(
      assistant.sendMessage(USER_ID, CONVERSATION_ID, {
        content: 'How do contributions work?',
      }),
    ).rejects.toBe(failure);
    expect(sdk).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: CONVERSATION_ID,
        role: 'user',
        content: 'How do contributions work?',
      },
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('awaits durable settlement before saving the assistant response', async () => {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    reconcile.mockImplementationOnce(async () => {
      enter();
      await pending;
      return {
        state: 'settled',
        actualTokens: 30,
        chargedTokens: '30',
        chargedSpendUsdNanos: '80000',
        priceVersion: PRICE_ID,
      };
    });
    const message = assistant.sendMessage(USER_ID, CONVERSATION_ID, {
      content: 'How do contributions work?',
    });
    await entered;
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    finish();
    await message;
    expect(prisma.message.create).toHaveBeenCalledTimes(2);
  });

  it.each(['assistant_message', 'conversation_update'] as const)(
    'settlement survives a subsequent %s persistence failure without another SDK attempt',
    async (write) => {
      const failure = new Error('message persistence unavailable');
      if (write === 'assistant_message') {
        prisma.message.create
          .mockReset()
          .mockResolvedValueOnce({ id: 'user-message' })
          .mockRejectedValueOnce(failure);
      } else {
        prisma.conversation.update.mockRejectedValueOnce(failure);
      }
      await expect(
        assistant.sendMessage(USER_ID, CONVERSATION_ID, {
          content: 'How do contributions work?',
        }),
      ).rejects.toBe(failure);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile.mock.calls[0][1]).toBe('success');
      expect(sdk).toHaveBeenCalledTimes(1);
      expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
    },
  );

  it('a settlement failure writes no assistant message and never retries the provider', async () => {
    const failure = new Error('durable reconciliation failed');
    reconcile.mockRejectedValueOnce(failure);
    await expect(
      assistant.sendMessage(USER_ID, CONVERSATION_ID, {
        content: 'How do contributions work?',
      }),
    ).rejects.toBe(failure);
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('preserves the safety refusal without admission, retrieval or provider work', async () => {
    safety.checkContent.mockReturnValueOnce({
      flagged: true,
      blocked: true,
      reason: 'blocklist_match',
    });
    const result = await assistant.sendMessage(USER_ID, CONVERSATION_ID, {
      content: 'blocked content',
    });
    expect(result.metadata).toEqual({
      provider: 'none',
      latencyMs: 0,
      tokens: 0,
      citations: [],
      flagged: true,
      flagReason: 'blocklist_match',
    });
    expect(prisma.message.create.mock.calls[1][0]).toEqual({
      data: {
        conversationId: CONVERSATION_ID,
        role: 'assistant',
        content: 'I cannot answer this request.',
      },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(retrieval).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it.each(['send', 'read', 'delete'] as const)(
    'rejects a foreign owner before %s work or accounting',
    async (operation) => {
      prisma.conversation.findUnique.mockResolvedValueOnce({
        id: CONVERSATION_ID,
        userId: '55555555-5555-4555-8555-555555555555',
      });
      const call =
        operation === 'send'
          ? assistant.sendMessage(USER_ID, CONVERSATION_ID, { content: 'Hello' })
          : operation === 'read'
            ? assistant.getConversationMessages(USER_ID, CONVERSATION_ID)
            : assistant.deleteConversation(USER_ID, CONVERSATION_ID);
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
      expect(safety.checkContent).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.conversation.delete).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(sdk).not.toHaveBeenCalled();
    },
  );

  it('still rejects missing conversations before paid work', async () => {
    prisma.conversation.findUnique.mockResolvedValueOnce(null);
    await expect(
      assistant.sendMessage(USER_ID, CONVERSATION_ID, { content: 'Hello' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(reserve).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
