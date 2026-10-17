import { AdminAuditLog } from './entities/admin-audit-log.entity';
import { AdminAuditHead } from './entities/admin-audit-head.entity';
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { AuditLog } from './entities/audit-log.entity';
import { AuditChainState } from './entities/audit-chain-state.entity';
import { ExportCursor } from './entities/export-cursor.entity';
import { Admin } from '../admin/entities/admin.entity';
import { AuditTrailService } from './services/audit-trail.service';
import { AuditRetentionService } from './services/audit-retention.service';
import {
  AuditQueueService,
  AUDIT_QUEUE_NAME,
} from './services/audit-queue.service';
import { ComplianceService } from './services/compliance.service';
import { SecurityMonitoringService } from './services/security-monitoring.service';
import { AuditMetricsService } from './services/audit-metrics.service';
import { AdminAuditService } from './services/admin-audit.service';
import { ExportCursorService } from './services/export-cursor.service';
import { AuditController } from './controllers/audit-log.controller';
import { AuditLoggingInterceptor } from './interceptors/audit-logging.interceptor';
import { AuditLogProcessor } from './processors/audit-log.processor';
import { AuditExportCapabilityGuard } from './guards/audit-export-capability.guard';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditLog,
      AuditChainState,
      AdminAuditLog,
      AdminAuditHead,
      ExportCursor,
    ]),
    TypeOrmModule.forFeature([AuditLog, Admin]),
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
    AdminAuditService,
    AuditLogProcessor,
    ExportCursorService,
    AuditExportCapabilityGuard,
  ],
  controllers: [AuditController],
  exports: [
    AuditTrailService,
    AuditLoggingInterceptor,
    AuditQueueService,
    ComplianceService,
    SecurityMonitoringService,
    AuditMetricsService,
    AdminAuditService,
    ExportCursorService,
  ],
})
export class AuditModule {}
