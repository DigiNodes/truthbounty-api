import { Module } from '@nestjs/common';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './ai-assistant.service';
import { LlmProviderService } from './llm-provider.service';
import { RagService } from './rag.service';
import { PrismaModule } from '../prisma/prisma.module';
// Note: assuming PrismaModule is exported from '../prisma/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService, LlmProviderService, RagService],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}
