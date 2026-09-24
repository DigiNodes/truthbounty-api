import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from './conversation.service';
import {
  ConversationMode,
  ConversationStatus,
} from '../entities/conversation.entity';
import { AiUsageStatus } from '../entities/ai-usage-log.entity';

describe('ConversationService', () => {
  let service: ConversationService;
  let conversationRepository: any;
  let messageRepository: any;
  let promptOrchestrationService: any;
  let safetyGuardrailService: any;
  let usageAnalyticsService: any;
  let cache: any;

  const buildService = () => {
    const configService = {
      get: jest.fn().mockReturnValue({ redactBeforeStore: false }),
    } as unknown as ConfigService;

    return new ConversationService(
      conversationRepository,
      messageRepository,
      promptOrchestrationService,
      safetyGuardrailService,
      usageAnalyticsService,
      cache,
      configService,
    );
  };

  beforeEach(() => {
    conversationRepository = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest.fn().mockImplementation(async (entry) => ({
        id: 'conv-1',
        totalTokens: 0,
        ...entry,
      })),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
    };
    messageRepository = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest
        .fn()
        .mockImplementation(async (entry) => ({ id: 'msg-1', ...entry })),
      find: jest.fn(),
    };
    promptOrchestrationService = { generateReply: jest.fn() };
    safetyGuardrailService = { redact: jest.fn() };
    usageAnalyticsService = { record: jest.fn() };
    cache = { invalidateConversationWindow: jest.fn() };
    service = buildService();
  });

  describe('create', () => {
    it('creates a general-mode conversation for any role', async () => {
      const conversation = await service.create('user-1', 'contributor', {
        title: 'hello',
      });
      expect(conversation.userId).toBe('user-1');
      expect(conversation.mode).toBe(ConversationMode.GENERAL);
    });

    it('rejects moderation_assist mode for a contributor', async () => {
      await expect(
        service.create('user-1', 'contributor', {
          mode: ConversationMode.MODERATION_ASSIST,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows moderation_assist mode for a moderator', async () => {
      const conversation = await service.create('user-1', 'moderator', {
        mode: ConversationMode.MODERATION_ASSIST,
      });
      expect(conversation.mode).toBe(ConversationMode.MODERATION_ASSIST);
    });

    it('rejects admin_analytics mode for a moderator', async () => {
      await expect(
        service.create('user-1', 'moderator', {
          mode: ConversationMode.ADMIN_ANALYTICS,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findOwned', () => {
    it('returns the conversation when it belongs to the requesting user', async () => {
      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        status: ConversationStatus.ACTIVE,
      });
      const conversation = await service.findOwned('user-1', 'conv-1');
      expect(conversation.id).toBe('conv-1');
    });

    it('throws NotFoundException when a different user owns the conversation (ownership isolation)', async () => {
      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-2',
        status: ConversationStatus.ACTIVE,
      });
      await expect(service.findOwned('user-1', 'conv-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the conversation does not exist', async () => {
      conversationRepository.findOne.mockResolvedValue(null);
      await expect(service.findOwned('user-1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('treats a soft-deleted conversation as not found', async () => {
      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        status: ConversationStatus.DELETED,
      });
      await expect(service.findOwned('user-1', 'conv-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        status: ConversationStatus.ACTIVE,
        mode: ConversationMode.GENERAL,
        totalTokens: 0,
        title: null,
      });
      promptOrchestrationService.generateReply.mockResolvedValue({
        content: 'Staking locks tokens.',
        citations: [],
        provider: 'mock',
        model: 'mock-model',
        promptTokens: 5,
        completionTokens: 3,
        totalTokens: 8,
        latencyMs: 42,
        fallback: false,
        flagged: false,
        safetyBlocked: false,
      });
    });

    it('persists the user and assistant messages, updates conversation totals, and logs usage', async () => {
      const result = await service.sendMessage(
        'user-1',
        'contributor',
        'conv-1',
        {
          content: 'How does staking work?',
        },
      );

      expect(result.userMessage.content).toBe('How does staking work?');
      expect(result.assistantMessage.content).toBe('Staking locks tokens.');
      expect(conversationRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          totalTokens: 8,
          lastProvider: 'mock',
          title: 'How does staking work?',
        }),
      );
      expect(cache.invalidateConversationWindow).toHaveBeenCalledWith('conv-1');
      expect(usageAnalyticsService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AiUsageStatus.SUCCESS,
          totalTokens: 8,
        }),
      );
    });

    it('rejects sending a message to a conversation owned by a different user', async () => {
      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-2',
        status: ConversationStatus.ACTIVE,
      });

      await expect(
        service.sendMessage('user-1', 'contributor', 'conv-1', {
          content: 'hi',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(promptOrchestrationService.generateReply).not.toHaveBeenCalled();
    });

    it('logs safety_blocked status when the reply was safety-blocked', async () => {
      promptOrchestrationService.generateReply.mockResolvedValue({
        content: "I can't help with that.",
        citations: [],
        provider: 'none',
        model: 'none',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 1,
        fallback: false,
        flagged: true,
        flagReason: 'blocklist_match',
        safetyBlocked: true,
      });

      await service.sendMessage('user-1', 'contributor', 'conv-1', {
        content: 'bad content',
      });

      expect(usageAnalyticsService.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: AiUsageStatus.SAFETY_BLOCKED }),
      );
    });
  });
});
