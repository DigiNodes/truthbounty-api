import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { AuditLog } from './entities/audit-log.entity';
import { AuditTrailService } from './services/audit-trail.service';
import { AuditRetentionService } from './services/audit-retention.service';
import { AuditQueueService, AUDIT_QUEUE_NAME } from './services/audit-queue.service';
import { ComplianceService } from './services/compliance.service';
import { SecurityMonitoringService } from './services/security-monitoring.service';
import { AuditMetricsService } from './services/audit-metrics.service';
import { AuditController } from './controllers/audit-log.controller';
import { AuditLoggingInterceptor } from './interceptors/audit-logging.interceptor';
import { AuditLogProcessor } from './processors/audit-log.processor';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog]),
    ScheduleModule,
    BullModule.registerQueue({
      name: AUDIT_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  providers: [
    AuditTrailService,
    AuditLoggingInterceptor,
    AuditRetentionService,
    AuditQueueService,
    ComplianceService,
    SecurityMonitoringService,
    AuditMetricsService,
    AuditLogProcessor,
  ],
  controllers: [AuditController],
  exports: [
    AuditTrailService,
    AuditLoggingInterceptor,
    AuditQueueService,
    ComplianceService,
    SecurityMonitoringService,
    AuditMetricsService,
  ],
})
export class AuditModule {}
