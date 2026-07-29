import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from './entities/admin.entity';
import { Incident } from './entities/incident.entity';
import { ModerationReport } from './entities/moderation-report.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
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
@Module({
  imports: [
    TypeOrmModule.forFeature([Admin, Incident, ModerationReport, AuditLog]),
  ],
  controllers: [
    AdminController,
    ModerationController,
    IncidentController,
    DashboardController,
  ],
  providers: [
    AdminService,
    ModerationService,
    IncidentService,
    DashboardService,
    RolesGuard,
    AdminGuard,
  ],
  exports: [
    AdminService,
    ModerationService,
    IncidentService,
    DashboardService,
    RolesGuard,
    AdminGuard,
  ],
})
export class AdminModule {}
