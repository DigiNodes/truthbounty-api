import { Injectable, NotFoundException, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { CreateConversationDto, SendMessageDto } from './dto/ai-assistant.dto';

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);

  constructor(
    private prisma: PrismaService,
    private llmProvider: LlmProviderService,
    private ragService: RagService,
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
      throw new ForbiddenException('You do not have access to this conversation');
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('You do not have access to this conversation');
    }

    // 1. Save user message
    const userMessage = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'user',
        content: dto.content,
      },
    });

    // 2. Retrieve Conversation History
    const history = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 10, // Short-term conversation memory limit
    });

    // 3. RAG Retrieval
    const { content: context, citations } = await this.ragService.retrieveContext(dto.content);

    // 4. Construct Prompt Pipeline
    const systemPrompt = `You are the TruthBounty AI Assistant. You help contributors navigate the protocol.
Your answers must be grounded ONLY in verified protocol information.
Do not fabricate protocol state or execute operations.
Protocol Context:
${context}
`;

    const messagesToLlm: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
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

    // 8. Track Usage Metrics
    await this.prisma.aiUsageMetric.create({
      data: {
        userId,
        provider: llmResponse.provider,
        model: llmResponse.model,
        promptTokens: llmResponse.usage?.prompt_tokens || 0,
        completionTokens: llmResponse.usage?.completion_tokens || 0,
        totalTokens: llmResponse.usage?.total_tokens || 0,
        latencyMs,
      },
    });

    // Standardized API response
    return {
      message: assistantMessage,
      metadata: {
        provider: llmResponse.provider,
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
      throw new ForbiddenException('You do not have access to this conversation');
    }

    await this.prisma.conversation.delete({
      where: { id: conversationId },
    });

    return { success: true };
  }
}
