import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Admin } from './entities/admin.entity';
import { Incident } from './entities/incident.entity';
import { ModerationReport } from './entities/moderation-report.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { Claim } from '../claims/entities/claim.entity';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { ModerationService } from './moderation/moderation.service';
import { ModerationController } from './moderation/moderation.controller';
import { IncidentService } from './incidents/incident.service';
import { IncidentController } from './incidents/incident.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { RolesGuard } from './guards/roles.guard';
import { AdminGuard } from './guards/admin.guard';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ProtocolAdminService } from './protocol/protocol-admin.service';
import { ProtocolAdminController } from './protocol/protocol-admin.controller';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { QueueName } from '../jobs/jobs.types';

@Module({
  imports: [
    TypeOrmModule.forFeature([Admin, Incident, ModerationReport, AuditLog, Claim]),
    FeatureFlagsModule,
    JobsModule,
    RedisModule,
    NotificationModule,
    MetricsModule,
    BullModule.registerQueue(
      { name: QueueName.DEFAULT },
      { name: QueueName.NOTIFICATIONS },
      { name: QueueName.BLOCKCHAIN },
      { name: QueueName.ANALYTICS },
    ),
  ],
  controllers: [
    AdminController,
    ModerationController,
    IncidentController,
    DashboardController,
    ProtocolAdminController,
  ],
  providers: [
    AdminService,
    ModerationService,
    IncidentService,
    DashboardService,
    RolesGuard,
    AdminGuard,
    ProtocolAdminService,
  ],
  exports: [
    AdminService,
    ModerationService,
    IncidentService,
    DashboardService,
    RolesGuard,
    AdminGuard,
    ProtocolAdminService,
  ],
})
export class AdminModule {}
