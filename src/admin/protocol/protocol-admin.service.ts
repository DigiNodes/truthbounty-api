import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { Admin, AdminRole } from '../entities/admin.entity';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { ConfigurationService } from '../../feature-flags/configuration.service';
import { JobsService } from '../../jobs/jobs.service';
import { QueueName } from '../../jobs/jobs.types';
import { RedisService } from '../../redis/redis.service';

import {
  ServiceType,
  QueueAction,
  ServiceAction,
  ControlServiceDto,
  ServiceControlResponse,
  AllQueueMetricsResponse,
  QueueMetricsResponse,
} from './dto/service-control.dto';
import {
  EmergencyAction,
  ExecuteEmergencyActionDto,
  EmergencyActionResponse,
  SystemStatusResponse,
} from './dto/emergency.dto';
import {
  SetMaintenanceModeDto,
  ScheduleMaintenanceDto,
  MaintenanceStatusResponse,
} from './dto/maintenance.dto';
import {
  ProtocolConfigDto,
  OperationalStatsResponse,
} from './dto/config.dto';

import {
  AuditActionType,
  AuditEntityType,
  AuditSeverity,
  AuditCategory,
} from '../../audit/entities/audit-log.entity';

interface EmergencyState {
  action: EmergencyAction;
  reason: string;
  timestamp: string;
  expiresAt?: number;
}

interface MaintenanceSchedule {
  id: string;
  description: string;
  startTime: string;
  endTime?: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  affectedServices?: string[];
  createdAt: string;
  createdBy?: string;
}

@Injectable()
export class ProtocolAdminService {
  private readonly logger = new Logger(ProtocolAdminService.name);

  private maintenanceActive = false;
  private maintenanceReason = '';
  private maintenanceStartedAt: string | null = null;
  private maintenanceScheduledEnd: string | null = null;
  private scheduledMaintenance: MaintenanceSchedule[] = [];
  private emergencyStates = new Map<string, EmergencyState>();
  private serviceStates = new Map<string, boolean>();
  private readonly startTime = Date.now();

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    private readonly auditTrailService: AuditTrailService,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly configService: ConfigurationService,
    private readonly jobsService: JobsService,
    private readonly redisService: RedisService,
    @InjectQueue(QueueName.DEFAULT) private readonly defaultQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATIONS)
    private readonly notificationsQueue: Queue,
    @InjectQueue(QueueName.BLOCKCHAIN)
    private readonly blockchainQueue: Queue,
    @InjectQueue(QueueName.ANALYTICS)
    private readonly analyticsQueue: Queue,
  ) {
    this.serviceStates.set('notifications', true);
    this.serviceStates.set('integrations', true);
    this.serviceStates.set('queues_operational', true);
  }

  // ──────────────────────────────────────────────
  //  SYSTEM STATUS
  // ──────────────────────────────────────────────

  async getSystemStatus(): Promise<SystemStatusResponse> {
    const activeEmergencies: string[] = [];
    this.emergencyStates.forEach((state, action) => {
      if (state.expiresAt) {
        if (Date.now() < state.expiresAt) {
          activeEmergencies.push(action);
        } else {
          this.emergencyStates.delete(action);
        }
      } else {
        activeEmergencies.push(action);
      }
    });

    return {
      maintenanceMode: this.maintenanceActive,
      emergencyActive: activeEmergencies.length > 0,
      activeEmergencies,
      queuesOperational: this.serviceStates.get('queues_operational') ?? true,
      notificationsEnabled: this.serviceStates.get('notifications') ?? true,
      integrationsOperational:
        this.serviceStates.get('integrations') ?? true,
      apiThrottlingActive: activeEmergencies.includes(
        EmergencyAction.ENABLE_API_THROTTLING,
      ),
      uptime: this.getUptime(),
      environment: process.env.NODE_ENV ?? 'development',
    };
  }

  async getOperationalStats(): Promise<OperationalStatsResponse> {
    const [totalUsers, totalAdmins, auditLogCount] = await Promise.all([
      this.countEntity('user'),
      this.adminRepo.count(),
      this.auditLogRepo.count(),
    ]);

    const allMetrics = await this.jobsService.getAllQueueMetrics();

    const totalWaiting = allMetrics.reduce((sum, m) => sum + m.waiting, 0);
    const totalActive = allMetrics.reduce((sum, m) => sum + m.active, 0);
    const totalFailed = allMetrics.reduce((sum, m) => sum + m.failed, 0);
    const totalCompleted = allMetrics.reduce(
      (sum, m) => sum + m.completed,
      0,
    );

    return {
      totalUsers,
      totalClaims: 0,
      totalDisputes: 0,
      totalAdmins,
      activeAdmins: 0,
      pendingClaims: 0,
      finalizedClaims: 0,
      auditLogCount,
      queueMetrics: {
        totalWaiting,
        totalActive,
        totalFailed,
        totalCompleted,
      },
      systemUptime: this.getUptime(),
      environment: process.env.NODE_ENV ?? 'development',
      timestamp: new Date().toISOString(),
    };
  }

  async getDetailedOperationalStats(): Promise<Record<string, unknown>> {
    const allMetrics = await this.jobsService.getAllQueueMetrics();
    const queueMetrics = allMetrics.reduce(
      (acc, m) => {
        acc[m.name] = {
          waiting: m.waiting,
          active: m.active,
          completed: m.completed,
          failed: m.failed,
          delayed: m.delayed,
          paused: m.paused,
        };
        return acc;
      },
      {} as Record<string, unknown>,
    );

    return {
      queues: queueMetrics,
      services: {
        maintenanceMode: this.maintenanceActive,
        notificationsEnabled: this.serviceStates.get('notifications') ?? true,
        integrationsOperational:
          this.serviceStates.get('integrations') ?? true,
        apiThrottlingActive: this.emergencyStates.has(
          EmergencyAction.ENABLE_API_THROTTLING,
        ),
      },
      system: {
        uptime: this.getUptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform,
      },
    };
  }

  // ──────────────────────────────────────────────
  //  MAINTENANCE MODE
  // ──────────────────────────────────────────────

  async setMaintenanceMode(
    dto: SetMaintenanceModeDto,
    adminId: string,
  ): Promise<MaintenanceStatusResponse> {
    const wasActive = this.maintenanceActive;
    this.maintenanceActive = dto.enabled;
    this.maintenanceReason = dto.reason ?? '';
    this.maintenanceStartedAt = dto.enabled
      ? new Date().toISOString()
      : null;
    this.maintenanceScheduledEnd = dto.scheduledEnd ?? null;

    const actionType = dto.enabled
      ? AuditActionType.MAINTENANCE_MODE_ENABLED
      : AuditActionType.MAINTENANCE_MODE_DISABLED;

    await this.auditTrailService.log({
      actionType,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: 'system',
      userId: adminId,
      severity: AuditSeverity.HIGH,
      category: AuditCategory.MAINTENANCE,
      description: dto.enabled
        ? `Maintenance mode enabled${dto.reason ? `: ${dto.reason}` : ''}`
        : 'Maintenance mode disabled',
      beforeState: { maintenanceActive: wasActive },
      afterState: { maintenanceActive: dto.enabled, reason: dto.reason },
    });

    this.logger.log(
      `Maintenance mode ${dto.enabled ? 'enabled' : 'disabled'} by admin ${adminId}`,
    );
    return this.getMaintenanceStatus();
  }

  async scheduleMaintenance(
    dto: ScheduleMaintenanceDto,
    adminId: string,
  ): Promise<MaintenanceSchedule> {
    const schedule: MaintenanceSchedule = {
      id: `mnt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      description: dto.description,
      startTime: dto.startTime,
      endTime: dto.endTime,
      status: 'scheduled',
      affectedServices: dto.affectedServices,
      createdAt: new Date().toISOString(),
      createdBy: adminId,
    };

    this.scheduledMaintenance.push(schedule);

    await this.auditTrailService.log({
      actionType: AuditActionType.MAINTENANCE_SCHEDULED,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: schedule.id,
      userId: adminId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.MAINTENANCE,
      description: `Scheduled maintenance: ${dto.description}`,
      afterState: schedule as unknown as Record<string, unknown>,
    });

    this.logger.log(
      `Maintenance scheduled: ${schedule.id} - ${dto.description}`,
    );
    return schedule;
  }

  async cancelMaintenance(
    scheduleId: string,
    adminId: string,
  ): Promise<void> {
    const index = this.scheduledMaintenance.findIndex(
      (s) => s.id === scheduleId,
    );
    if (index === -1) {
      throw new NotFoundException(
        `Maintenance schedule ${scheduleId} not found`,
      );
    }

    const schedule = this.scheduledMaintenance[index];
    if (schedule.status !== 'scheduled') {
      throw new ConflictException(
        `Cannot cancel maintenance with status '${schedule.status}'`,
      );
    }

    this.scheduledMaintenance[index] = {
      ...schedule,
      status: 'cancelled',
    };

    await this.auditTrailService.log({
      actionType: AuditActionType.MAINTENANCE_CANCELLED,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: scheduleId,
      userId: adminId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.MAINTENANCE,
      description: `Cancelled maintenance: ${schedule.description}`,
      beforeState: { status: schedule.status },
      afterState: { status: 'cancelled' },
    });
  }

  async getMaintenanceStatus(): Promise<MaintenanceStatusResponse> {
    return {
      active: this.maintenanceActive,
      reason: this.maintenanceReason || undefined,
      startedAt: this.maintenanceStartedAt ?? undefined,
      scheduledEnd: this.maintenanceScheduledEnd ?? undefined,
      scheduledMaintenance: this.scheduledMaintenance.filter(
        (s) => s.status === 'scheduled' || s.status === 'active',
      ),
    };
  }

  // ──────────────────────────────────────────────
  //  SERVICE MANAGEMENT
  // ──────────────────────────────────────────────

  async controlService(
    dto: ControlServiceDto,
    adminId: string,
  ): Promise<ServiceControlResponse> {
    const { serviceType, action, queueName, reason } = dto;
    const beforeState = {
      operational: this.serviceStates.get(serviceType) ?? true,
    };

    try {
      switch (serviceType) {
        case ServiceType.QUEUE:
          return await this.handleQueueAction(
            action as QueueAction,
            queueName,
            adminId,
            reason,
            beforeState,
          );
        case ServiceType.NOTIFICATION:
          return await this.handleNotificationAction(
            action as ServiceAction,
            adminId,
            reason,
            beforeState,
          );
        case ServiceType.WEBHOOK:
          return await this.handleWebhookAction(
            action as ServiceAction,
            adminId,
            reason,
            beforeState,
          );
        case ServiceType.CACHE:
          return await this.handleCacheAction(
            action as ServiceAction,
            adminId,
            beforeState,
          );
        case ServiceType.BLOCKCHAIN_INDEXER:
        case ServiceType.BACKGROUND_PROCESSOR:
        case ServiceType.SCHEDULED_JOB:
          return await this.handleGenericServiceAction(
            serviceType,
            action as ServiceAction,
            adminId,
            reason,
            beforeState,
          );
        default:
          throw new BadRequestException(
            `Unknown service type: ${serviceType}`,
          );
      }
    } catch (error) {
      this.logger.error(
        `Service control failed: ${serviceType}/${action} - ${(error as Error).message}`,
      );
      return {
        serviceType,
        action,
        success: false,
        message: (error as Error).message,
        previousState: JSON.stringify(beforeState),
        currentState: JSON.stringify({
          operational: this.serviceStates.get(serviceType) ?? true,
        }),
      };
    }
  }

  private async handleQueueAction(
    action: QueueAction,
    queueName?: string,
    adminId?: string,
    reason?: string,
    beforeState?: Record<string, unknown>,
  ): Promise<ServiceControlResponse> {
    const queuesToActOn = queueName
      ? [queueName]
      : [QueueName.DEFAULT, QueueName.NOTIFICATIONS, QueueName.BLOCKCHAIN, QueueName.ANALYTICS];

    let auditActionType: AuditActionType;

    for (const name of queuesToActOn) {
      switch (action) {
        case QueueAction.PAUSE:
          await this.jobsService.pauseQueue(name as QueueName);
          auditActionType = AuditActionType.QUEUE_PAUSED;
          break;
        case QueueAction.RESUME:
          await this.jobsService.resumeQueue(name as QueueName);
          auditActionType = AuditActionType.QUEUE_RESUMED;
          break;
        case QueueAction.RETRY_FAILED:
          await this.jobsService.retryFailed(name as QueueName);
          auditActionType = AuditActionType.SERVICE_HEALTH_CHECK;
          break;
        case QueueAction.CLEAR:
          await this.clearQueue(name as QueueName);
          auditActionType = AuditActionType.SERVICE_SUSPENDED;
          break;
        default:
          throw new BadRequestException(`Unknown queue action: ${action}`);
      }
    }

    if (adminId) {
      await this.auditTrailService.log({
        actionType: auditActionType!,
        entityType: AuditEntityType.QUEUE,
        entityId: queuesToActOn.join(','),
        userId: adminId,
        severity: AuditSeverity.HIGH,
        category: AuditCategory.SERVICE_CONTROL,
        description: `${action} ${action === QueueAction.RETRY_FAILED ? 'failed jobs on' : ''} queue(s): ${queuesToActOn.join(', ')}${reason ? ` - ${reason}` : ''}`,
        beforeState,
        afterState: { action, queues: queuesToActOn, reason },
      });
    }

    return {
      serviceType: ServiceType.QUEUE,
      action,
      success: true,
      message: `Queue(s) ${queuesToActOn.join(', ')} ${action}d successfully`,
      previousState: beforeState ? JSON.stringify(beforeState) : undefined,
      currentState: JSON.stringify({ operational: true }),
    };
  }

  private async handleNotificationAction(
    action: ServiceAction,
    adminId?: string,
    reason?: string,
    beforeState?: Record<string, unknown>,
  ): Promise<ServiceControlResponse> {
    const isSuspending = action === ServiceAction.SUSPEND;
    this.serviceStates.set('notifications', !isSuspending);

    const auditActionType = isSuspending
      ? AuditActionType.SERVICE_SUSPENDED
      : AuditActionType.SERVICE_RESTORED;

    if (adminId) {
      await this.auditTrailService.log({
        actionType: auditActionType,
        entityType: AuditEntityType.SERVICE,
        entityId: 'notification-service',
        userId: adminId,
        severity: AuditSeverity.HIGH,
        category: AuditCategory.SERVICE_CONTROL,
        description: `${isSuspending ? 'Suspended' : 'Restored'} notification service${reason ? `: ${reason}` : ''}`,
        beforeState,
        afterState: {
          notificationsEnabled: !isSuspending,
          reason,
        },
      });
    }

    return {
      serviceType: ServiceType.NOTIFICATION,
      action,
      success: true,
      message: `Notification service ${isSuspending ? 'suspended' : 'restored'} successfully`,
      previousState: beforeState ? JSON.stringify(beforeState) : undefined,
    };
  }

  private async handleWebhookAction(
    action: ServiceAction,
    adminId?: string,
    reason?: string,
    beforeState?: Record<string, unknown>,
  ): Promise<ServiceControlResponse> {
    const isSuspending = action === ServiceAction.SUSPEND;
    this.serviceStates.set('integrations', !isSuspending);

    const auditActionType = isSuspending
      ? AuditActionType.INTEGRATION_SUSPENDED
      : AuditActionType.INTEGRATION_RESTORED;

    if (adminId) {
      await this.auditTrailService.log({
        actionType: auditActionType,
        entityType: AuditEntityType.INTEGRATION,
        entityId: 'webhook-service',
        userId: adminId,
        severity: AuditSeverity.HIGH,
        category: AuditCategory.SERVICE_CONTROL,
        description: `${isSuspending ? 'Suspended' : 'Restored'} webhook service${reason ? `: ${reason}` : ''}`,
        beforeState,
        afterState: {
          integrationsOperational: !isSuspending,
          reason,
        },
      });
    }

    return {
      serviceType: ServiceType.WEBHOOK,
      action,
      success: true,
      message: `Webhook service ${isSuspending ? 'suspended' : 'restored'} successfully`,
      previousState: beforeState ? JSON.stringify(beforeState) : undefined,
    };
  }

  private async handleCacheAction(
    action: ServiceAction,
    adminId?: string,
    beforeState?: Record<string, unknown>,
  ): Promise<ServiceControlResponse> {
    if (action !== ServiceAction.INVALIDATE_CACHE) {
      throw new BadRequestException(
        `Invalid action for cache service: ${action}`,
      );
    }

    await this.redisService.flushall();
    this.logger.log('Cache invalidated globally');

    if (adminId) {
      await this.auditTrailService.log({
        actionType: AuditActionType.CACHE_INVALIDATED,
        entityType: AuditEntityType.CACHE,
        entityId: 'global-cache',
        userId: adminId,
        severity: AuditSeverity.MEDIUM,
        category: AuditCategory.SERVICE_CONTROL,
        description: 'Global cache invalidated',
        beforeState,
        afterState: { cacheCleared: true, timestamp: new Date().toISOString() },
      });
    }

    return {
      serviceType: ServiceType.CACHE,
      action,
      success: true,
      message: 'Global cache invalidated successfully',
      previousState: beforeState ? JSON.stringify(beforeState) : undefined,
    };
  }

  private async handleGenericServiceAction(
    serviceType: ServiceType,
    action: ServiceAction,
    adminId?: string,
    reason?: string,
    beforeState?: Record<string, unknown>,
  ): Promise<ServiceControlResponse> {
    const serviceKey = serviceType;
    const isSuspending = action === ServiceAction.SUSPEND;
    this.serviceStates.set(serviceKey, !isSuspending);

    const auditActionType = isSuspending
      ? AuditActionType.SERVICE_SUSPENDED
      : AuditActionType.SERVICE_RESTORED;

    if (adminId) {
      await this.auditTrailService.log({
        actionType: auditActionType,
        entityType: AuditEntityType.SERVICE,
        entityId: serviceType,
        userId: adminId,
        severity: AuditSeverity.MEDIUM,
        category: AuditCategory.SERVICE_CONTROL,
        description: `${isSuspending ? 'Suspended' : 'Restored'} ${serviceType}${reason ? `: ${reason}` : ''}`,
        beforeState,
        afterState: { operational: !isSuspending, reason },
      });
    }

    return {
      serviceType,
      action,
      success: true,
      message: `${serviceType} ${isSuspending ? 'suspended' : 'restored'} successfully`,
      previousState: beforeState ? JSON.stringify(beforeState) : undefined,
    };
  }

  async getQueueMetrics(): Promise<AllQueueMetricsResponse> {
    const allMetrics = await this.jobsService.getAllQueueMetrics();

    const queues: QueueMetricsResponse[] = allMetrics.map((m) => ({
      name: m.name,
      waiting: m.waiting,
      active: m.active,
      completed: m.completed,
      failed: m.failed,
      delayed: m.delayed,
      paused: m.paused,
    }));

    return {
      queues,
      totalWaiting: queues.reduce((s, q) => s + q.waiting, 0),
      totalActive: queues.reduce((s, q) => s + q.active, 0),
      totalFailed: queues.reduce((s, q) => s + q.failed, 0),
    };
  }

  async retryFailedJobs(
    queueName?: string,
    adminId?: string,
  ): Promise<{ retried: number }> {
    let totalRetried = 0;

    const queuesToRetry = queueName
      ? [queueName as QueueName]
      : [QueueName.DEFAULT, QueueName.NOTIFICATIONS, QueueName.BLOCKCHAIN, QueueName.ANALYTICS];

    for (const name of queuesToRetry) {
      const retried = await this.jobsService.retryFailed(name);
      totalRetried += retried;
    }

    if (adminId) {
      await this.auditTrailService.log({
        actionType: AuditActionType.SERVICE_HEALTH_CHECK,
        entityType: AuditEntityType.QUEUE,
        entityId: 'failed-jobs',
        userId: adminId,
        severity: AuditSeverity.LOW,
        category: AuditCategory.OPERATIONS,
        description: `Retried ${totalRetried} failed jobs on ${queuesToRetry.join(', ')}`,
        afterState: { retried: totalRetried, queues: queuesToRetry },
      });
    }

    return { retried: totalRetried };
  }

  // ──────────────────────────────────────────────
  //  EMERGENCY OPERATIONS
  // ──────────────────────────────────────────────

  async executeEmergencyAction(
    dto: ExecuteEmergencyActionDto,
    adminId: string,
  ): Promise<EmergencyActionResponse> {
    const { action, reason, durationMinutes } = dto;
    const expiresAt = durationMinutes
      ? Date.now() + durationMinutes * 60 * 1000
      : undefined;

    const emergency: EmergencyState = {
      action,
      reason,
      timestamp: new Date().toISOString(),
      expiresAt,
    };

    this.emergencyStates.set(action, emergency);

    const affectedServices = this.getAffectedServices(action);
    this.applyEmergencyState(action, true);

    await this.auditTrailService.log({
      actionType: AuditActionType.EMERGENCY_ACTION_EXECUTED,
      entityType: AuditEntityType.SERVICE,
      entityId: `emergency-${action}`,
      userId: adminId,
      severity: AuditSeverity.CRITICAL,
      category: AuditCategory.EMERGENCY,
      description: `Emergency action: ${action} - ${reason}`,
      afterState: {
        action,
        reason,
        expiresAt: expiresAt
          ? new Date(expiresAt).toISOString()
          : undefined,
        affectedServices,
      },
    });

    this.logger.warn(
      `Emergency action executed: ${action} by admin ${adminId} - ${reason}`,
    );

    return {
      action,
      success: true,
      timestamp: emergency.timestamp,
      message: `Emergency action '${action}' executed successfully. Reason: ${reason}`,
      affectedServices,
    };
  }

  async resolveEmergencyAction(
    action: EmergencyAction,
    adminId: string,
  ): Promise<void> {
    const emergency = this.emergencyStates.get(action);
    if (!emergency) {
      throw new NotFoundException(
        `No active emergency action: ${action}`,
      );
    }

    this.emergencyStates.delete(action);
    this.applyEmergencyState(action, false);

    await this.auditTrailService.log({
      actionType: AuditActionType.SERVICE_RESTORED,
      entityType: AuditEntityType.SERVICE,
      entityId: `emergency-${action}`,
      userId: adminId,
      severity: AuditSeverity.HIGH,
      category: AuditCategory.EMERGENCY,
      description: `Resolved emergency action: ${action}`,
      beforeState: emergency as unknown as Record<string, unknown>,
      afterState: { resolved: true, resolvedAt: new Date().toISOString() },
    });

    this.logger.log(
      `Emergency action resolved: ${action} by admin ${adminId}`,
    );
  }

  private getAffectedServices(action: EmergencyAction): string[] {
    switch (action) {
      case EmergencyAction.SUSPEND_ALL_SERVICES:
        return [
          'queues',
          'notifications',
          'webhooks',
          'blockchain_indexer',
          'background_processor',
        ];
      case EmergencyAction.DISABLE_NOTIFICATIONS:
        return ['notifications'];
      case EmergencyAction.PAUSE_ALL_QUEUES:
        return ['queues'];
      case EmergencyAction.SUSPEND_INTEGRATIONS:
        return ['webhooks', 'integrations'];
      case EmergencyAction.ENABLE_API_THROTTLING:
        return ['api'];
      case EmergencyAction.EMERGENCY_SHUTDOWN:
        return ['all'];
      default:
        return ['unknown'];
    }
  }

  private applyEmergencyState(action: EmergencyAction, active: boolean): void {
    switch (action) {
      case EmergencyAction.SUSPEND_ALL_SERVICES:
        this.serviceStates.set('notifications', !active);
        this.serviceStates.set('integrations', !active);
        this.serviceStates.set('queues_operational', !active);
        break;
      case EmergencyAction.DISABLE_NOTIFICATIONS:
        this.serviceStates.set('notifications', !active);
        break;
      case EmergencyAction.PAUSE_ALL_QUEUES:
        this.serviceStates.set('queues_operational', !active);
        break;
      case EmergencyAction.SUSPEND_INTEGRATIONS:
        this.serviceStates.set('integrations', !active);
        break;
      case EmergencyAction.EMERGENCY_SHUTDOWN:
        this.serviceStates.set('notifications', !active);
        this.serviceStates.set('integrations', !active);
        this.serviceStates.set('queues_operational', !active);
        this.maintenanceActive = active;
        break;
    }
  }

  // ──────────────────────────────────────────────
  //  CONFIGURATION MANAGEMENT
  // ──────────────────────────────────────────────

  async getProtocolConfig(
    key: string,
    environment?: string,
  ): Promise<{ key: string; value: unknown } | null> {
    return this.configService.get(key, environment);
  }

  async setProtocolConfig(
    dto: ProtocolConfigDto,
    adminId: string,
  ): Promise<unknown> {
    const beforeValue = await this.configService.get(
      dto.key,
      dto.environment,
    );

    const saved = await this.configService.set(
      dto.key,
      dto.value,
      dto.environment,
      adminId,
      dto.changeReason,
    );

    await this.auditTrailService.log({
      actionType: AuditActionType.PROTOCOL_CONFIG_UPDATED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: saved.id,
      userId: adminId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.PROTOCOL,
      description: `Updated protocol config: ${dto.key}${dto.changeReason ? ` - ${dto.changeReason}` : ''}`,
      beforeState: beforeValue
        ? ({ value: beforeValue } as Record<string, unknown>)
        : undefined,
      afterState: {
        key: dto.key,
        value: dto.value,
        changeReason: dto.changeReason,
      },
    });

    return saved;
  }

  async listAllConfig(environment?: string): Promise<unknown[]> {
    return this.configService.findAll(environment);
  }

  // ──────────────────────────────────────────────
  //  FEATURE FLAGS
  // ──────────────────────────────────────────────

  async listFeatureFlags(environment?: string) {
    return this.featureFlagsService.findAll(environment);
  }

  async evaluateFeatureFlag(
    key: string,
    context?: Record<string, unknown>,
  ) {
    return this.featureFlagsService.evaluate(key, context);
  }

  // ──────────────────────────────────────────────
  //  AUDIT & METRICS
  // ──────────────────────────────────────────────

  async getAdminAuditLogs(
    limit = 50,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const [logs, total] = await this.auditLogRepo.findAndCount({
      where: { category: AuditCategory.ADMINISTRATIVE },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { logs, total };
  }

  async getProtocolAuditLogs(
    limit = 50,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const [logs, total] = await this.auditLogRepo.findAndCount({
      where: [
        { category: AuditCategory.MAINTENANCE },
        { category: AuditCategory.EMERGENCY },
        { category: AuditCategory.SERVICE_CONTROL },
        { category: AuditCategory.PROTOCOL },
      ],
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });
    return { logs, total };
  }

  // ──────────────────────────────────────────────
  //  HELPERS
  // ──────────────────────────────────────────────

  private async clearQueue(queueName: QueueName): Promise<void> {
    const queue = this.getQueueInstance(queueName);
    if (!queue) {
      throw new NotFoundException(`Queue ${queueName} not found`);
    }
    await queue.drain();
    this.logger.log(`Queue ${queueName} cleared`);
  }

  private getQueueInstance(name: QueueName): Queue | undefined {
    const instances: Record<string, Queue> = {
      [QueueName.DEFAULT]: this.defaultQueue,
      [QueueName.NOTIFICATIONS]: this.notificationsQueue,
      [QueueName.BLOCKCHAIN]: this.blockchainQueue,
      [QueueName.ANALYTICS]: this.analyticsQueue,
    };
    return instances[name];
  }

  private async countEntity(table: string): Promise<number> {
    try {
      const result = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM ${table}`,
      );
      return Number(result[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }

  private getUptime(): number {
    return Date.now() - this.startTime;
  }
}
