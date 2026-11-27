import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import aiConfig from './config/ai.config';
import { AiAssistantModule } from './ai-assistant.module';
import { ContextRetrievalService } from './services/context-retrieval.service';
import { AiProviderRouterService } from './services/ai-provider-router.service';
import { PromptOrchestrationService } from './services/prompt-orchestration.service';
import { ConversationService } from './services/conversation.service';
import { RedisModule } from '../redis/redis.module';

describe('AiAssistantModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [aiConfig] }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          autoLoadEntities: true,
          synchronize: true,
        }),
        RedisModule,
        AiAssistantModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('bootstraps only the canonical context, provider, and conversation services', () => {
    expect(module.get(ContextRetrievalService)).toBeInstanceOf(
      ContextRetrievalService,
    );
    expect(module.get(AiProviderRouterService)).toBeInstanceOf(
      AiProviderRouterService,
    );
    expect(module.get(PromptOrchestrationService)).toBeInstanceOf(
      PromptOrchestrationService,
    );
    expect(module.get(ConversationService)).toBeInstanceOf(
      ConversationService,
    );
  });
});
