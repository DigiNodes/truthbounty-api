import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditLog } from './entities/audit-log.entity';
import { AuditTrailService } from './services/audit-trail.service';
import { AuditSearchService } from './services/audit-search.service';
import { AuditComplianceService } from './services/audit-compliance.service';
import { AuditMetricsService } from './services/audit-metrics.service';
import { AuditRetentionService } from './services/audit-retention.service';
import { AuditController } from './controllers/audit-log.controller';
import { AuditLoggingInterceptor } from './interceptors/audit-logging.interceptor';
import { RolesGuard } from '../auth/guards/roles.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog]), ScheduleModule],
  providers: [
    AuditTrailService,
    AuditSearchService,
    AuditComplianceService,
    AuditMetricsService,
    AuditRetentionService,
    AuditLoggingInterceptor,
    RolesGuard,
  ],
  controllers: [AuditController],
  exports: [
    AuditTrailService,
    AuditSearchService,
    AuditComplianceService,
    AuditMetricsService,
    AuditRetentionService,
    AuditLoggingInterceptor,
  ],
})
export class AuditModule {}
