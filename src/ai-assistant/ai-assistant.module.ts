import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './services/ai-assistant.service';
import { LlmProviderService } from './services/llm-provider.service';
import { RagService } from './services/rag.service';
import { SafetyGuardrailService } from './services/safety-guardrail.service';
import { ContextDocument } from './entities/context-document.entity';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [PrismaModule, RedisModule, TypeOrmModule.forFeature([ContextDocument])],
  controllers: [AiAssistantController],
  providers: [AiAssistantService, LlmProviderService, RagService, SafetyGuardrailService],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}
