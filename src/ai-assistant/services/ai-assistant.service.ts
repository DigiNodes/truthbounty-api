import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { CreateConversationDto, SendMessageDto } from '../dto/ai-assistant.dto';

@Injectable()
export class AiAssistantService {
  private readonly mutationClaims = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private llmProvider: LlmProviderService,
    private ragService: RagService,
    private safetyGuardrail: SafetyGuardrailService,
  ) {}

  async createConversation(userId: string, dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        userId,
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
    idempotencyKey?: string,
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
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey))
    ) {
      throw new BadRequestException('Invalid Idempotency-Key header');
    }
    const claim =
      idempotencyKey === undefined
        ? ['content', dto.content]
        : ['key', idempotencyKey];
    const claimKey = JSON.stringify([userId, conversationId, ...claim]);
    const claimedAt = this.mutationClaims.get(claimKey);
    if (claimedAt !== undefined && Date.now() - claimedAt < 60_000) {
      throw new ConflictException('Duplicate message request');
    }
    this.mutationClaims.set(claimKey, Date.now());

    // 0. Safety Check
    const safetyCheck = this.safetyGuardrail.checkContent(dto.content);

    // 1. Save user message
    await this.prisma.message.create({
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
    ).toReversed();

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
    const llmResponse = await this.llmProvider.generateResponse(messagesToLlm, {
      userId,
    });

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

    // Standardized API response
    return {
      message: assistantMessage,
      metadata: {
        provider: llmResponse.provider,
        model: llmResponse.model,
        latencyMs,
        tokens: llmResponse.accounting
          ? llmResponse.accounting.actualTokens
          : llmResponse.usage?.total_tokens ?? null,
        usageState: llmResponse.accounting?.state ?? 'mock',
        chargedTokens: llmResponse.accounting?.chargedTokens ?? null,
        chargedSpendUsdNanos:
          llmResponse.accounting?.chargedSpendUsdNanos ?? null,
        priceVersion: llmResponse.accounting?.priceVersion ?? null,
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
