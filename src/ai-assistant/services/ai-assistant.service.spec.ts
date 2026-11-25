import { AnalyticsConsentService } from '../../analytics/analytics-consent.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiAssistantService } from './ai-assistant.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';

describe('AiAssistantService optional usage metrics', () => {
  const prisma = {
    conversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'conversation-1',
        userId: 'user-1',
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    message: {
      create: jest.fn().mockResolvedValue({ id: 'message' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiUsageMetric: { create: jest.fn().mockResolvedValue({}) },
  };
  const llm = {
    generateResponse: jest.fn().mockResolvedValue({
      content: 'response',
      provider: 'test',
      model: 'test',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  };
  const rag = {
    retrieveContext: jest.fn().mockResolvedValue({
      context: 'context',
      citations: [],
    }),
  };
  const guardrail = {
    checkContent: jest.fn().mockReturnValue({ flagged: false }),
  };
  const consent = {
    collectIfValid: jest.fn(),
    getSubjectKey: jest.fn((subjectId: string) => `hmac:${subjectId}`),
  };

  let service: AiAssistantService;

  beforeEach(() => {
    jest.clearAllMocks();
    consent.collectIfValid.mockResolvedValue({ allowed: false });
    service = new AiAssistantService(
      prisma as unknown as PrismaService,
      llm as unknown as LlmProviderService,
      rag as unknown as RagService,
      guardrail as unknown as SafetyGuardrailService,
      consent as unknown as AnalyticsConsentService,
    );
  });

  const send = () =>
    service.sendMessage('user-1', 'conversation-1', { content: 'hello' });

  it('does not store per-user usage without consent', async () => {
    await send();
    expect(consent.collectIfValid).toHaveBeenCalledWith(
      'user-1',
      expect.any(Function),
    );
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });

  it('stores usage within the current-consent transaction', async () => {
    consent.collectIfValid.mockImplementation(
      async (
        _subjectId: string,
        collect: (tx: PrismaService) => Promise<unknown>,
      ) => ({
        allowed: true,
        value: await collect(prisma as unknown as PrismaService),
      }),
    );

    await send();

    expect(prisma.aiUsageMetric.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'hmac:user-1',
        totalTokens: 3,
      }),
    });
  });
});
