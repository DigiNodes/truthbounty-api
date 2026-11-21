import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiConversationsController } from './controllers/ai-conversations.controller';
import { AiKnowledgeBaseController } from './controllers/ai-knowledge-base.controller';
import { AiAnalyticsController } from './controllers/ai-analytics.controller';
import { AiStreamController } from './controllers/ai-stream.controller';
import { ConversationService } from './services/conversation.service';
import { PromptOrchestrationService } from './services/prompt-orchestration.service';
import { ContextRetrievalService } from './services/context-retrieval.service';
import { AiProviderRouterService } from './services/ai-provider-router.service';
import { KnowledgeBaseService } from './services/knowledge-base.service';
import { UsageAnalyticsService } from './services/usage-analytics.service';
import { SafetyGuardrailService } from './services/safety-guardrail.service';
import { OpenAiProvider } from './providers/openai.provider';
import { MockProvider } from './providers/mock.provider';
import { AiAssistantCache } from './cache/ai-assistant.cache';
import { AiMetricsService } from './metrics/ai-metrics.service';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { ContextDocument } from './entities/context-document.entity';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([
      Conversation,
      Message,
      ContextDocument,
      AiUsageLog,
    ]),
  ],
  controllers: [
    AiConversationsController,
    AiKnowledgeBaseController,
    AiAnalyticsController,
    AiStreamController,
  ],
  providers: [
    ConversationService,
    PromptOrchestrationService,
    ContextRetrievalService,
    AiProviderRouterService,
    KnowledgeBaseService,
    UsageAnalyticsService,
    SafetyGuardrailService,
    OpenAiProvider,
    MockProvider,
    AiAssistantCache,
    AiMetricsService,
  ],
  exports: [ConversationService, PromptOrchestrationService],
})
export class AiAssistantModule {}
