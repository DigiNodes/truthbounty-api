import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Message,
  MessageCitation,
  MessageRole,
} from '../entities/message.entity';
import {
  Conversation,
  ConversationMode,
} from '../entities/conversation.entity';
import { ContextDocumentCategory } from '../entities/context-document.entity';
import { ContextRetrievalService } from './context-retrieval.service';
import { SafetyGuardrailService } from './safety-guardrail.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import {
  AiProviderRouterService,
  AiProviderName,
} from './ai-provider-router.service';
import {
  AiChatMessage,
  AiStreamChunk,
} from '../providers/ai-provider.interface';
import { Observable } from 'rxjs';
import { AiEndpointLabel } from '../metrics/ai-metrics.service';
import { buildSystemPrompt } from '../config/prompt-templates';
import { AiConfig } from '../config/ai.config';
import { AppUserRole } from '../../auth/decorators/roles.decorator';

export interface OrchestratedReply {
  content: string;
  citations: MessageCitation[];
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  fallback: boolean;
  flagged: boolean;
  flagReason?: string;
  safetyBlocked: boolean;
}

export interface BlockedPreparation {
  blocked: true;
  refusalContent: string;
  flagReason?: string;
}

export interface ReadyPreparation {
  blocked: false;
  messages: AiChatMessage[];
  citations: MessageCitation[];
  canaryToken: string;
}

export type Preparation = BlockedPreparation | ReadyPreparation;

export interface StreamPreparation extends ReadyPreparation {
  providerName: string;
  fallback: boolean;
  stream: Observable<AiStreamChunk>;
}

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const CATEGORY_WEIGHTING: Partial<
  Record<ConversationMode, ContextDocumentCategory[]>
> = {
  [ConversationMode.MODERATION_ASSIST]: [
    ContextDocumentCategory.MODERATION_POLICY,
    ContextDocumentCategory.GOVERNANCE,
  ],
  [ConversationMode.ADMIN_ANALYTICS]: [
    ContextDocumentCategory.API_DOCS,
    ContextDocumentCategory.PROTOCOL_DOCS,
  ],
};

interface GenerateReplyParams {
  conversation: Conversation;
  requesterId: string;
  requesterRole: AppUserRole;
  userContent: string;
  endpoint: AiEndpointLabel;
  providerOverride?: AiProviderName;
}

@Injectable()
export class PromptOrchestrationService {
  private readonly aiConfig: AiConfig;

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    private readonly contextRetrievalService: ContextRetrievalService,
    private readonly safetyGuardrailService: SafetyGuardrailService,
    private readonly cache: AiAssistantCache,
    private readonly providerRouter: AiProviderRouterService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  private async buildMemoryWindow(
    conversationId: string,
  ): Promise<AiChatMessage[]> {
    const cached = await this.cache.getConversationWindow(conversationId);
    if (cached) {
      return cached;
    }

    const recent = await this.messageRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: this.aiConfig.memoryWindowMessages,
    });
    const chronological = recent.reverse();

    // Trim from the oldest until under budget, always keeping the latest message.
    let tokenTotal = chronological.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );
    const trimmed = [...chronological];
    while (
      trimmed.length > 1 &&
      tokenTotal > this.aiConfig.memoryWindowTokenBudget
    ) {
      const removed = trimmed.shift();
      if (removed) {
        tokenTotal -= estimateTokens(removed.content);
      }
    }

    const window: AiChatMessage[] = trimmed
      .filter((m) => m.role !== MessageRole.SYSTEM)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    await this.cache.setConversationWindow(conversationId, window);
    return window;
  }

  /**
   * Safety check, context retrieval, memory-window assembly, and prompt
   * construction — shared by both the non-streaming (generateReply) and
   * streaming (prepareStream) paths so there is exactly one place
   * (buildMessages here) that decides message ordering and can never let
   * caller content become a system message.
   */
  private async prepare(params: {
    conversation: Conversation;
    requesterRole: AppUserRole;
    userContent: string;
  }): Promise<Preparation> {
    const { conversation, requesterRole, userContent } = params;

    const contentCheck = this.safetyGuardrailService.checkContent(userContent);
    if (contentCheck.blocked) {
      return {
        blocked: true,
        refusalContent: this.safetyGuardrailService.REFUSAL_MESSAGE,
        flagReason: contentCheck.reason,
      };
    }

    const categories = CATEGORY_WEIGHTING[conversation.mode];
    const contextResults = await this.contextRetrievalService.search(
      userContent,
      {
        topN: this.aiConfig.contextTopN,
        categories,
      },
    );

    const memoryWindow = await this.buildMemoryWindow(conversation.id);

    const canaryToken = this.safetyGuardrailService.generateCanaryToken();
    const systemPrompt = buildSystemPrompt(
      conversation.mode,
      requesterRole,
      canaryToken,
    );

    const messages: AiChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ];
    if (contextResults.length > 0) {
      const contextBlock = contextResults
        .map(
          (c, i) =>
            `[${i + 1}] ${c.title}: ${c.content.slice(0, 500)}${c.sourceUrl ? ` (source: ${c.sourceUrl})` : ''}`,
        )
        .join('\n');
      messages.push({
        role: 'system',
        content: `Relevant knowledge base context:\n\n${contextBlock}`,
      });
    }
    messages.push(...memoryWindow);
    messages.push({ role: 'user', content: userContent });

    const citations: MessageCitation[] = contextResults.map((c) => ({
      documentId: c.documentId,
      title: c.title,
      score: c.score,
      sourceUrl: c.sourceUrl,
    }));

    return { blocked: false, messages, citations, canaryToken };
  }

  async generateReply(params: GenerateReplyParams): Promise<OrchestratedReply> {
    const {
      conversation,
      requesterId,
      requesterRole,
      userContent,
      endpoint,
      providerOverride,
    } = params;
    const start = Date.now();

    const prepared = await this.prepare({
      conversation,
      requesterRole,
      userContent,
    });
    if (prepared.blocked) {
      return {
        content: prepared.refusalContent,
        citations: [],
        provider: 'none',
        model: 'none',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - start,
        fallback: false,
        flagged: true,
        flagReason: prepared.flagReason,
        safetyBlocked: true,
      };
    }

    const { response, provider, fallback } = await this.providerRouter.chat(
      {
        messages: prepared.messages,
        userId: requesterId,
        requestId: conversation.id,
      },
      endpoint,
      requesterRole,
      providerOverride,
    );

    let content = response.content;
    let flagged = false;
    let flagReason: string | undefined;
    if (
      this.safetyGuardrailService.containsCanaryLeak(
        content,
        prepared.canaryToken,
      )
    ) {
      content = this.safetyGuardrailService.LEAK_REFUSAL_MESSAGE;
      flagged = true;
      flagReason = 'prompt_leak_detected';
    }

    return {
      content,
      citations: prepared.citations,
      provider,
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      totalTokens: response.totalTokens,
      latencyMs: Date.now() - start,
      fallback,
      flagged,
      flagReason,
      safetyBlocked: false,
    };
  }

  /**
   * Streaming counterpart to generateReply: runs the same safety/context/
   * memory preparation, then resolves (without yet invoking) the provider
   * to use, leaving the actual .stream() call and persistence to the
   * caller (AiStreamController), since chunk emission is inherently tied
   * to the SSE response lifecycle.
   */
  async prepareStream(params: {
    conversation: Conversation;
    requesterRole: AppUserRole;
    userContent: string;
    providerOverride?: AiProviderName;
  }): Promise<BlockedPreparation | StreamPreparation> {
    const { conversation, requesterRole, userContent, providerOverride } =
      params;
    const prepared = await this.prepare({
      conversation,
      requesterRole,
      userContent,
    });
    if (prepared.blocked) {
      return prepared;
    }

    const { provider, fallback } = await this.providerRouter.resolveForRequest(
      requesterRole,
      providerOverride,
    );
    const stream = provider.stream({
      messages: prepared.messages,
      userId: conversation.userId,
      requestId: conversation.id,
    });

    return { ...prepared, providerName: provider.name, fallback, stream };
  }

  async invalidateMemoryWindow(conversationId: string): Promise<void> {
    await this.cache.invalidateConversationWindow(conversationId);
  }
}
