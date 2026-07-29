import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '../redis/redis.module';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { ContextDocument } from './entities/context-document.entity';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import aiConfig from './config/ai.config';

import { OpenAiProvider } from './providers/openai.provider';
import { MockProvider } from './providers/mock.provider';

import { AiAssistantCache } from './cache/ai-assistant.cache';
import { AiMetricsService } from './metrics/ai-metrics.service';
import { SafetyGuardrailService } from './services/safety-guardrail.service';
import { ContextRetrievalService } from './services/context-retrieval.service';
import { AiProviderRouterService } from './services/ai-provider-router.service';
import { PromptOrchestrationService } from './services/prompt-orchestration.service';
import { ConversationService } from './services/conversation.service';
import { UsageAnalyticsService } from './services/usage-analytics.service';
import { KnowledgeBaseService } from './services/knowledge-base.service';

import { AiConversationsController } from './controllers/ai-conversations.controller';
import { AiStreamController } from './controllers/ai-stream.controller';
import { AiKnowledgeBaseController } from './controllers/ai-knowledge-base.controller';
import { AiAnalyticsController } from './controllers/ai-analytics.controller';

import { AiExceptionFilter } from './common/filters/ai-exception.filter';
import { AiResponseInterceptor } from './common/interceptors/ai-response.interceptor';
import { RolesGuard } from '../auth/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forFeature(aiConfig),
    TypeOrmModule.forFeature([
      Conversation,
      Message,
      ContextDocument,
      AiUsageLog,
    ]),
    RedisModule,
  ],
  controllers: [
    AiConversationsController,
    AiStreamController,
    AiKnowledgeBaseController,
    AiAnalyticsController,
  ],
  providers: [
    OpenAiProvider,
    MockProvider,
    AiAssistantCache,
    AiMetricsService,
    SafetyGuardrailService,
    ContextRetrievalService,
    AiProviderRouterService,
    PromptOrchestrationService,
    ConversationService,
    UsageAnalyticsService,
    KnowledgeBaseService,
    AiExceptionFilter,
    AiResponseInterceptor,
    RolesGuard,
  ],
  exports: [ConversationService, UsageAnalyticsService, KnowledgeBaseService],
})
export class AiAssistantModule {}
