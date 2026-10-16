import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditTrailService } from './services/audit-trail.service';
import { AuditController } from './controllers/audit-log.controller';
import { AuditLoggingInterceptor } from './interceptors/audit-logging.interceptor';
import { TracingModule } from '../tracing/tracing.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog]), TracingModule],
  providers: [AuditTrailService, AuditLoggingInterceptor],
  controllers: [AuditController],
  exports: [AuditTrailService, AuditLoggingInterceptor],
})
export class AuditModule {}
