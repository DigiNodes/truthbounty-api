import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditLog } from './entities/audit-log.entity';
import { AuditTrailService } from './services/audit-trail.service';
import { AuditRetentionService } from './services/audit-retention.service';
import { AuditController } from './controllers/audit-log.controller';
import { AuditLoggingInterceptor } from './interceptors/audit-logging.interceptor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog]), ScheduleModule],
  providers: [AuditTrailService, AuditLoggingInterceptor, AuditRetentionService],
  controllers: [AuditController],
  exports: [AuditTrailService, AuditLoggingInterceptor],
})
export class AuditModule {}
