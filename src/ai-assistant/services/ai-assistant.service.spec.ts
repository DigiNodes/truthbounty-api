import { Test, TestingModule } from '@nestjs/testing';
import { AiAssistantService } from './ai-assistant.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';

describe('AiAssistantService', () => {
  let service: AiAssistantService;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const mockPrismaService = {
      conversation: {
        create: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1' }),
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

    const mockLlmProvider = {
      generateResponse: jest.fn().mockResolvedValue({
        content: 'Mock AI Response',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        provider: 'mock',
        model: 'mock',
      }),
    };

    const mockRagService = {
      retrieveContext: jest.fn().mockResolvedValue({ context: 'mock context', citations: [] }),
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
      ],
    }).compile();

    service = module.get<AiAssistantService>(AiAssistantService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a conversation', async () => {
    const result = await service.createConversation('user-1', { title: 'Test' });
    expect(result).toHaveProperty('id', 'conv-1');
  });

  it('should send a message and save to history', async () => {
    const result = await service.sendMessage('user-1', 'conv-1', { content: 'Hello' });
    expect(result.message).toBeDefined();
    expect(result.metadata.provider).toBe('mock');
  });
});
