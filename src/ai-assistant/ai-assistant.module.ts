import { Module } from '@nestjs/common';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './services/ai-assistant.service';
import { LlmProviderService } from './services/llm-provider.service';
import { RagService } from './services/rag.service';
import { SafetyGuardrailService } from './services/safety-guardrail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService, LlmProviderService, RagService, SafetyGuardrailService],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}
