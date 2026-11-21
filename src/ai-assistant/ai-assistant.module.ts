import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './services/ai-assistant.service';
import { LlmProviderService } from './services/llm-provider.service';
import { RagService } from './services/rag.service';
import { SafetyGuardrailService } from './services/safety-guardrail.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiBudgetService } from './budgets/ai-budget.service';
import { AiBudgetAdminService } from './budgets/ai-budget-admin.service';
import { AiBudgetController } from './budgets/ai-budget.controller';
import { AiBudgetOperatorGuard } from './budgets/ai-budget-operator.guard';
import { AiBudgetExceptionFilter } from './budgets/ai-budget-exception.filter';
import {
  AiBudgetAuthorityEntity, AiBudgetPolicyEntity, AiBudgetPriceEntity,
  AiBudgetAttemptEntity, AiBudgetOverrideEntity,
} from './budgets/ai-budget.entity';
import { AiUsageLog } from './entities/ai-usage-log.entity';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    // Reuse the global PostgreSQL DataSource; this declares metadata/repositories,
    // and never creates another connection or persistence authority.
    TypeOrmModule.forFeature([
      AiBudgetAuthorityEntity, AiBudgetPolicyEntity, AiBudgetPriceEntity,
      AiBudgetAttemptEntity, AiBudgetOverrideEntity, AiUsageLog,
    ]),
  ],
  controllers: [AiAssistantController, AiBudgetController],
  providers: [
    AiAssistantService, LlmProviderService, RagService, SafetyGuardrailService,
    AiBudgetService, AiBudgetAdminService, AiBudgetOperatorGuard,
    AiBudgetExceptionFilter, RolesGuard,
  ],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}
