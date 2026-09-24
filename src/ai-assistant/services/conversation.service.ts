import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Conversation,
  ConversationMode,
  ConversationStatus,
} from '../entities/conversation.entity';
import {
  Message,
  MessageCitation,
  MessageRole,
} from '../entities/message.entity';
import {
  AiUsageEndpoint,
  AiUsageStatus,
} from '../entities/ai-usage-log.entity';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { ConversationQueryDto } from '../dto/conversation-query.dto';
import { SendMessageDto } from '../dto/send-message.dto';
import { PromptOrchestrationService } from './prompt-orchestration.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { UsageAnalyticsService } from './usage-analytics.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiConfig } from '../config/ai.config';
import { AppUserRole } from '../../auth/decorators/roles.decorator';

const MODE_REQUIRED_ROLES: Partial<Record<ConversationMode, AppUserRole[]>> = {
  [ConversationMode.MODERATION_ASSIST]: ['moderator', 'admin'],
  [ConversationMode.ADMIN_ANALYTICS]: ['admin'],
};

export interface SendMessageResult {
  userMessage: Message;
  assistantMessage: Message;
  fallback: boolean;
}

@Injectable()
export class ConversationService {
  private readonly aiConfig: AiConfig;

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly promptOrchestrationService: PromptOrchestrationService,
    private readonly safetyGuardrailService: SafetyGuardrailService,
    private readonly usageAnalyticsService: UsageAnalyticsService,
    private readonly cache: AiAssistantCache,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  private assertModeAllowed(mode: ConversationMode, role: AppUserRole): void {
    const requiredRoles = MODE_REQUIRED_ROLES[mode];
    if (requiredRoles && !requiredRoles.includes(role)) {
      throw new ForbiddenException(
        `Conversation mode "${mode}" requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }
  }

  async create(
    userId: string,
    role: AppUserRole,
    dto: CreateConversationDto,
  ): Promise<Conversation> {
    const mode = dto.mode ?? ConversationMode.GENERAL;
    this.assertModeAllowed(mode, role);

    const conversation = this.conversationRepository.create({
      userId,
      title: dto.title,
      mode,
      status: ConversationStatus.ACTIVE,
    });
    return this.conversationRepository.save(conversation);
  }

  async list(
    userId: string,
    query: ConversationQueryDto,
  ): Promise<{ items: Conversation[]; total: number }> {
    const [items, total] = await this.conversationRepository.findAndCount({
      where: { userId, ...(query.status ? { status: query.status } : {}) },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 20,
      skip: query.offset ?? 0,
    });
    return { items, total };
  }

  /** Loads a conversation, scoped to its owner; other users get 404, not 403, to avoid leaking existence. */
  async findOwned(
    userId: string,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      conversation.userId !== userId ||
      conversation.status === ConversationStatus.DELETED
    ) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  async listMessages(
    userId: string,
    conversationId: string,
  ): Promise<Message[]> {
    const conversation = await this.findOwned(userId, conversationId);
    return this.messageRepository.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'ASC' },
    });
  }

  async archive(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.findOwned(userId, conversationId);
    conversation.status = ConversationStatus.ARCHIVED;
    return this.conversationRepository.save(conversation);
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.findOwned(userId, conversationId);
    conversation.status = ConversationStatus.DELETED;
    await this.conversationRepository.save(conversation);
  }

  private maybeRedact(content: string): { content: string; redacted: boolean } {
    if (!this.aiConfig.redactBeforeStore) {
      return { content, redacted: false };
    }
    const { text, redacted } = this.safetyGuardrailService.redact(content);
    return { content: text, redacted };
  }

  private async persistUserMessage(
    conversation: Conversation,
    content: string,
    setTitleIfMissing: boolean,
  ): Promise<Message> {
    const stored = this.maybeRedact(content);
    const userMessage = await this.messageRepository.save(
      this.messageRepository.create({
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: stored.content,
        redacted: stored.redacted,
      }),
    );

    if (setTitleIfMissing && !conversation.title) {
      conversation.title = content.slice(0, 80);
      await this.conversationRepository.save(conversation);
    }

    return userMessage;
  }

  /**
   * Persists the assistant reply, updates conversation totals, invalidates
   * the memory-window cache, and logs usage. Shared by the non-streaming
   * sendMessage flow and AiStreamController's terminal SSE event, so both
   * paths record usage/analytics identically.
   */
  async finalizeAssistantMessage(params: {
    conversation: Conversation;
    userId: string;
    content: string;
    citations: MessageCitation[];
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
    flagged: boolean;
    flagReason?: string;
    endpoint: AiUsageEndpoint;
    status: AiUsageStatus;
  }): Promise<Message> {
    const { conversation } = params;
    const assistantStored = this.maybeRedact(params.content);

    const assistantMessage = await this.messageRepository.save(
      this.messageRepository.create({
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: assistantStored.content,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens: params.totalTokens,
        citations: params.citations,
        provider: params.provider,
        model: params.model,
        latencyMs: params.latencyMs,
        flagged: params.flagged,
        flagReason: params.flagReason,
        redacted: assistantStored.redacted,
      }),
    );

    conversation.totalTokens += params.totalTokens;
    conversation.lastProvider = params.provider;
    await this.conversationRepository.save(conversation);
    await this.cache.invalidateConversationWindow(conversation.id);

    await this.usageAnalyticsService.record({
      userId: params.userId,
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      provider: params.provider,
      model: params.model,
      endpoint: params.endpoint,
      status: params.status,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
      latencyMs: params.latencyMs,
    });

    return assistantMessage;
  }

  async sendMessage(
    userId: string,
    role: AppUserRole,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<SendMessageResult> {
    const conversation = await this.findOwned(userId, conversationId);
    const userMessage = await this.persistUserMessage(
      conversation,
      dto.content,
      true,
    );

    const reply = await this.promptOrchestrationService.generateReply({
      conversation,
      requesterId: userId,
      requesterRole: role,
      userContent: dto.content,
      endpoint: 'chat',
      providerOverride: dto.providerOverride,
    });

    const assistantMessage = await this.finalizeAssistantMessage({
      conversation,
      userId,
      content: reply.content,
      citations: reply.citations,
      provider: reply.provider,
      model: reply.model,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
      totalTokens: reply.totalTokens,
      latencyMs: reply.latencyMs,
      flagged: reply.flagged,
      flagReason: reply.flagReason,
      endpoint: AiUsageEndpoint.CHAT,
      status: reply.safetyBlocked
        ? AiUsageStatus.SAFETY_BLOCKED
        : AiUsageStatus.SUCCESS,
    });

    return { userMessage, assistantMessage, fallback: reply.fallback };
  }

  /** Persists the user message and returns it; used to stage a streamed reply. */
  async stageStreamMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<Message> {
    const conversation = await this.findOwned(userId, conversationId);
    return this.persistUserMessage(conversation, content, true);
  }
}
