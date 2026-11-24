import {
  Injectable,
  NotFoundException,
  Logger,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsConsentService } from '../../analytics/analytics-consent.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { CreateConversationDto, SendMessageDto } from '../dto/ai-assistant.dto';

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);
  private readonly mutationClaims = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private llmProvider: LlmProviderService,
    private ragService: RagService,
    private safetyGuardrail: SafetyGuardrailService,
    private readonly analyticsConsent: AnalyticsConsentService,
  ) {}

  async createConversation(userId: string, dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        userId: this.analyticsConsent.getSubjectKey(userId),
        title: dto.title || 'New Conversation',
      },
    });
  }

  async getConversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getConversationMessages(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException(
        'You do not have access to this conversation',
      );
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException(
        'You do not have access to this conversation',
      );
    }

    // #879: claim the mutation before the first write so a retried request
    // cannot append a second user message and LLM response.
    const claimKey = `${userId}:${conversationId}:${dto.content}`;
    const claimedAt = this.mutationClaims.get(claimKey);
    if (claimedAt !== undefined && Date.now() - claimedAt < 60_000) {
      throw new ConflictException('Duplicate message request');
    }
    this.mutationClaims.set(claimKey, Date.now());

    // 0. Safety Check
    const safetyCheck = this.safetyGuardrail.checkContent(dto.content);

    // 1. Save user message
    const userMessage = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'user',
        content: dto.content,
      },
    });

    if (safetyCheck.flagged) {
      const assistantMessage = await this.prisma.message.create({
        data: {
          conversationId,
          role: 'assistant',
          content: 'I cannot answer this request.',
        },
      });

      return {
        message: assistantMessage,
        metadata: {
          provider: 'none',
          latencyMs: 0,
          tokens: 0,
          citations: [],
          flagged: true,
          flagReason: safetyCheck.reason,
        },
      };
    }

    // 2. Retrieve Conversation History
    // #880: take the newest messages first, then restore chronological order.
    // Ascending + take(10) kept the oldest turns and dropped the live context.
    const history = (
      await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 10, // Short-term conversation memory limit
      })
    ).reverse();

    // 3. RAG Retrieval
    const { context, citations } = await this.ragService.retrieveContext(
      dto.content,
    );

    // 4. Construct Prompt Pipeline
    const systemPrompt = `You are the TruthBounty AI Assistant. You help contributors navigate the protocol.
Your answers must be grounded ONLY in verified protocol information.
Do not fabricate protocol state or execute operations.
Protocol Context:
${context}
`;

    const messagesToLlm: {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((msg) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      })),
    ];

    const startTime = Date.now();

    // 5. Orchestrate LLM request
    const llmResponse = await this.llmProvider.generateResponse(messagesToLlm);

    const latencyMs = Date.now() - startTime;

    // 6. Save assistant response
    const assistantMessage = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content: llmResponse.content,
      },
    });

    // 7. Update conversation updated at
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // Optional user-linked usage metrics require a current consent check and
    // are written under the same subject lock as withdrawal and rotation.
    try {
      await this.analyticsConsent.collectIfValid(userId, (tx) =>
        tx.aiUsageMetric.create({
          data: {
            userId,
            provider: llmResponse.provider,
            model: llmResponse.model,
            promptTokens: llmResponse.usage?.prompt_tokens || 0,
            completionTokens: llmResponse.usage?.completion_tokens || 0,
            totalTokens: llmResponse.usage?.total_tokens || 0,
            latencyMs,
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        'Optional AI usage metric was skipped because consent or persistence could not be verified',
        error instanceof Error ? error.name : 'Unknown error',
      );
    }

    // Standardized API response
    return {
      message: assistantMessage,
      metadata: {
        provider: llmResponse.provider,
        model: llmResponse.model,
        latencyMs,
        tokens: llmResponse.usage?.total_tokens || 0,
        citations,
      },
    };

  }

  async deleteConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException(
        'You do not have access to this conversation',
      );
    }

    await this.prisma.conversation.delete({
      where: { id: conversationId },
    });

    return { success: true };
  }
}
