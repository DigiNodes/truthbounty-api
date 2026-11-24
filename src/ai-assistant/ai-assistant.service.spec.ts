import { Test, TestingModule } from '@nestjs/testing';
import { AiAssistantService } from './ai-assistant.service';
import { PrismaService } from '../prisma/prisma.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { AnalyticsConsentService } from '../analytics/analytics-consent.service';

describe('AiAssistantService', () => {
  let service: AiAssistantService;
  let prismaService: PrismaService;
  let analyticsConsent: {
    collectIfValid: jest.Mock;
    getSubjectKey: jest.Mock;
  };

  beforeEach(async () => {
    const mockPrismaService = {
      conversation: {
        create: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'conv-1', userId: 'user-1' }),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      message: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      aiUsageMetric: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    analyticsConsent = {
      collectIfValid: jest.fn().mockResolvedValue({ allowed: false }),
      getSubjectKey: jest.fn((subjectId: string) => `hmac:${subjectId}`),
    };

    const mockLlmProvider = {
      generateResponse: jest.fn().mockResolvedValue({
        content: 'Mock AI Response',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        provider: 'mock',
        model: 'mock',
      }),
    };

    const mockRagService = {
      retrieveContext: jest.fn().mockResolvedValue({
        context: 'mock context',
        citations: [],
      }),
    };

    const mockSafetyGuardrail = {
      checkContent: jest.fn().mockReturnValue({ flagged: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiAssistantService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: LlmProviderService, useValue: mockLlmProvider },
        { provide: RagService, useValue: mockRagService },
        { provide: SafetyGuardrailService, useValue: mockSafetyGuardrail },
        { provide: AnalyticsConsentService, useValue: analyticsConsent },
      ],
    }).compile();

    service = module.get<AiAssistantService>(AiAssistantService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a conversation', async () => {
    const result = await service.createConversation('user-1', {
      title: 'Test',
    });
    expect(result).toHaveProperty('id', 'conv-1');
  });

  it('should send a message and save to history', async () => {
    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'Hello',
    });
    expect(result.message).toBeDefined();
    expect(result.metadata.provider).toBe('mock');
    expect(result.metadata.model).toBe('mock');
    expect((prismaService as any).aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('records AI usage metrics only inside a valid consent transaction', async () => {
    analyticsConsent.collectIfValid.mockImplementation(
      async (
        _subjectId: string,
        collect: (tx: PrismaService) => Promise<unknown>,
      ) => ({
        allowed: true,
        value: await collect(prismaService),
      }),
    );

    await service.sendMessage('user-1', 'conv-1', { content: 'Hello' });

    expect(analyticsConsent.collectIfValid).toHaveBeenCalledWith(
      'user-1',
      expect.any(Function),
    );
    expect((prismaService as any).aiUsageMetric.create).toHaveBeenCalled();
  });
});
