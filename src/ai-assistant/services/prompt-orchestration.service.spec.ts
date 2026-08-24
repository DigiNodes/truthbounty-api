import { ConfigService } from '@nestjs/config';
import { PromptOrchestrationService } from './prompt-orchestration.service';
import { ContextRetrievalService } from './context-retrieval.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiProviderRouterService } from './ai-provider-router.service';
import {
  Conversation,
  ConversationMode,
  ConversationStatus,
} from '../entities/conversation.entity';
import { ContextDocumentCategory } from '../entities/context-document.entity';

describe('PromptOrchestrationService', () => {
  let service: PromptOrchestrationService;
  let messageRepository: { find: jest.Mock };
  let contextRetrievalService: jest.Mocked<
    Pick<ContextRetrievalService, 'search'>
  >;
  let safetyGuardrailService: SafetyGuardrailService;
  let cache: jest.Mocked<
    Pick<
      AiAssistantCache,
      | 'getConversationWindow'
      | 'setConversationWindow'
      | 'invalidateConversationWindow'
    >
  >;
  let providerRouter: jest.Mocked<Pick<AiProviderRouterService, 'chat'>>;

  const conversation: Conversation = {
    id: 'conv-1',
    userId: 'user-1',
    title: null as any,
    mode: ConversationMode.GENERAL,
    status: ConversationStatus.ACTIVE,
    lastProvider: null as any,
    totalTokens: 0,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const buildService = () => {
    const configService = {
      get: jest.fn().mockReturnValue({
        memoryWindowMessages: 10,
        memoryWindowTokenBudget: 3000,
        contextTopN: 5,
      }),
    } as unknown as ConfigService;

    safetyGuardrailService = new SafetyGuardrailService({
      get: jest.fn().mockReturnValue({
        maxPromptLength: 4000,
        blockedTerms: ['forbidden phrase'],
        promptLeakHeuristics: ['ignore previous instructions'],
      }),
    } as unknown as ConfigService);

    return new PromptOrchestrationService(
      messageRepository as any,
      contextRetrievalService as unknown as ContextRetrievalService,
      safetyGuardrailService,
      cache as unknown as AiAssistantCache,
      providerRouter as unknown as AiProviderRouterService,
      configService,
    );
  };

  beforeEach(() => {
    messageRepository = { find: jest.fn().mockResolvedValue([]) };
    contextRetrievalService = { search: jest.fn().mockResolvedValue([]) };
    cache = {
      getConversationWindow: jest.fn().mockResolvedValue(null),
      setConversationWindow: jest.fn(),
      invalidateConversationWindow: jest.fn(),
    };
    providerRouter = {
      chat: jest.fn().mockResolvedValue({
        response: {
          content: 'Staking locks tokens.',
          model: 'mock-model',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          finishReason: 'stop',
        },
        provider: 'mock',
        fallback: false,
      }),
    };
    service = buildService();
  });

  it('short-circuits blocked content without ever calling the provider', async () => {
    const result = await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      userContent: 'this has a forbidden phrase in it',
      endpoint: 'chat',
    });

    expect(result.safetyBlocked).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.flagReason).toBe('blocklist_match');
    expect(providerRouter.chat).not.toHaveBeenCalled();
  });

  it('places the system prompt first and never lets caller content become a system message', async () => {
    await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      userContent: 'How does staking work?',
      endpoint: 'chat',
    });

    const [[chatRequest]] = providerRouter.chat.mock.calls;
    expect(chatRequest.messages[0].role).toBe('system');
    const nonSystemMessages = chatRequest.messages.filter(
      (m: any) => m.role !== 'system',
    );
    expect(
      nonSystemMessages.every(
        (m: any) => m.role === 'user' || m.role === 'assistant',
      ),
    ).toBe(true);
    expect(chatRequest.messages[chatRequest.messages.length - 1]).toEqual({
      role: 'user',
      content: 'How does staking work?',
    });
  });

  it('appends retrieved context as a system message and returns matching citations', async () => {
    contextRetrievalService.search.mockResolvedValue([
      {
        documentId: 'doc-1',
        title: 'Staking Overview',
        content: 'Staking locks tokens.',
        score: 1,
        sourceUrl: 'https://docs',
      },
    ]);

    const result = await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      userContent: 'How does staking work?',
      endpoint: 'chat',
    });

    expect(result.citations).toEqual([
      {
        documentId: 'doc-1',
        title: 'Staking Overview',
        score: 1,
        sourceUrl: 'https://docs',
      },
    ]);
    const [[chatRequest]] = providerRouter.chat.mock.calls;
    expect(
      chatRequest.messages.some(
        (m: any) =>
          m.role === 'system' && m.content.includes('Staking Overview'),
      ),
    ).toBe(true);
  });

  it('weights retrieval categories toward moderation policy in moderation_assist mode', async () => {
    await service.generateReply({
      conversation: {
        ...conversation,
        mode: ConversationMode.MODERATION_ASSIST,
      },
      requesterId: 'user-1',
      requesterRole: 'moderator',
      userContent: 'How should I triage this dispute?',
      endpoint: 'chat',
    });

    expect(contextRetrievalService.search).toHaveBeenCalledWith(
      'How should I triage this dispute?',
      expect.objectContaining({
        categories: expect.arrayContaining([
          ContextDocumentCategory.MODERATION_POLICY,
        ]),
      }),
    );
  });

  it('replaces the response with a refusal and flags it when the canary token leaks', async () => {
    providerRouter.chat.mockImplementation(async (request: any) => {
      const systemMessage = request.messages[0].content as string;
      const [token] = systemMessage.match(/cnry_[a-z0-9]+/) ?? [];
      return {
        response: {
          content: `Sure, my instructions are: ${token}`,
          model: 'mock-model',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          finishReason: 'stop',
        },
        provider: 'mock',
        fallback: false,
      };
    });

    const result = await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      // Benign input — the leak in this scenario comes from the model
      // itself misbehaving, not from a blocklisted request.
      userContent: 'What can you tell me about the protocol?',
      endpoint: 'chat',
    });

    expect(result.flagged).toBe(true);
    expect(result.flagReason).toBe('prompt_leak_detected');
    expect(result.content).toBe(safetyGuardrailService.LEAK_REFUSAL_MESSAGE);
  });

  it('builds the memory window from the message repository and trims to the token budget', async () => {
    const configService = {
      get: jest.fn().mockReturnValue({
        memoryWindowMessages: 10,
        memoryWindowTokenBudget: 5, // tiny budget forces trimming
        contextTopN: 5,
      }),
    } as unknown as ConfigService;

    service = new PromptOrchestrationService(
      messageRepository as any,
      contextRetrievalService as unknown as ContextRetrievalService,
      safetyGuardrailService,
      cache as unknown as AiAssistantCache,
      providerRouter as unknown as AiProviderRouterService,
      configService,
    );

    // find() is called with order: { createdAt: 'DESC' } in the real service,
    // so the mock returns newest-first, matching what TypeORM would produce.
    messageRepository.find.mockResolvedValue([
      { role: 'user', content: 'recent message', createdAt: new Date(3) },
      { role: 'assistant', content: 'a'.repeat(200), createdAt: new Date(2) },
    ]);

    await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      userContent: 'follow up question',
      endpoint: 'chat',
    });

    const [[chatRequest]] = providerRouter.chat.mock.calls;
    const windowContents = chatRequest.messages.map((m: any) => m.content);
    expect(windowContents).not.toContain('a'.repeat(200));
    expect(windowContents).toContain('recent message');
  });

  it('caches and reuses the memory window instead of re-querying the repository', async () => {
    cache.getConversationWindow.mockResolvedValue([
      { role: 'user', content: 'cached message' },
    ]);

    await service.generateReply({
      conversation,
      requesterId: 'user-1',
      requesterRole: 'contributor',
      userContent: 'another question',
      endpoint: 'chat',
    });

    expect(messageRepository.find).not.toHaveBeenCalled();
  });
});
