import { randomUUID } from 'crypto';
import { getRuntimeEnvironment } from '../../config/runtime-config';
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
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
import { OperationalControl } from '../entities/operational-control.entity';
import { OperationalControlEvent } from '../entities/operational-control-event.entity';

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
import { ProtocolConfigDto, OperationalStatsResponse } from './dto/config.dto';

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

export interface MaintenanceSchedule {
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
export class ProtocolAdminService implements OnModuleInit {
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
    @InjectRepository(OperationalControl)
    private readonly controlRepo: Repository<OperationalControl>,
    @InjectRepository(OperationalControlEvent)
    private readonly controlEventRepo: Repository<OperationalControlEvent>,
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

  async onModuleInit(): Promise<void> {
    await this.reconcilePersistedState();
  }

  private async reconcilePersistedState(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OperationalControl);
      let control = await repo.findOne({
        where: { id: 'system' },
        lock: { mode: 'pessimistic_write' },
      });

      let created = false;
      if (!control) {
        created = true;
        control = repo.create({
          id: 'system',
          maintenanceActive: false,
          maintenanceReason: null,
          maintenanceStartedAt: null,
          maintenanceScheduledEnd: null,
          schedules: [],
          emergencies: {},
          services: {},
          pendingCanonicalActions: {},
          updatedBy: null,
        });
      }

      const now = Date.now();
      let dirty = created;

      const emergencies = { ...(control.emergencies ?? {}) } as Record<
        string,
        EmergencyState & { expiresAt?: number }
      >;
      for (const [action, state] of Object.entries(emergencies)) {
        if (state.expiresAt && state.expiresAt <= now) {
          delete emergencies[action];
          dirty = true;
        }
      }

      const schedules = (control.schedules ??
        []) as unknown as MaintenanceSchedule[];
      for (const schedule of schedules) {
        let nextStatus = schedule.status;
        if (
          schedule.status === 'scheduled' &&
          Date.parse(schedule.startTime) <= now
        ) {
          nextStatus =
            !schedule.endTime || Date.parse(schedule.endTime) > now
              ? 'active'
              : 'completed';
        } else if (
          (schedule.status === 'active' || schedule.status === 'scheduled') &&
          schedule.endTime &&
          Date.parse(schedule.endTime) <= now
        ) {
          nextStatus = 'completed';
        }
        if (nextStatus !== schedule.status) {
          schedule.status = nextStatus;
          dirty = true;
        }
      }

      const pendingCanonical = {
        ...(control.pendingCanonicalActions ?? {}),
      } as Record<string, { status?: string }>;
      for (const [action, pending] of Object.entries(pendingCanonical)) {
        if (pending.status === 'resolved') {
          delete pendingCanonical[action];
          dirty = true;
        }
      }

      if (dirty) {
        control.emergencies = emergencies;
        control.schedules = schedules as unknown as Record<string, unknown>[];
        control.pendingCanonicalActions = pendingCanonical;
        control.updatedAt = new Date();
        await repo.save(control);
      }
      this.loadControlCache(control);
    });
  }

  private loadControlCache(control: OperationalControl): void {
    this.maintenanceActive = control.maintenanceActive;
    this.maintenanceReason = control.maintenanceReason ?? '';
    this.maintenanceStartedAt =
      control.maintenanceStartedAt?.toISOString() ?? null;
    this.maintenanceScheduledEnd =
      control.maintenanceScheduledEnd?.toISOString() ?? null;
    this.scheduledMaintenance = (control.schedules ??
      []) as unknown as MaintenanceSchedule[];
    this.emergencyStates = new Map(
      Object.entries(control.emergencies ?? {}) as [string, EmergencyState][],
    );

    const services = {
      notifications: true,
      integrations: true,
      queues_operational: true,
      ...(control.services ?? {}),
    } as Record<string, boolean>;
    const now = Date.now();
    for (const state of this.emergencyStates.values()) {
      if (state.expiresAt && state.expiresAt <= now) continue;
      for (const key of this.emergencyServiceKeys(state.action)) {
        services[key] = false;
      }
    }
    this.serviceStates = new Map(Object.entries(services));
  }

  private emergencyServiceKeys(action: EmergencyAction): string[] {
    switch (action) {
      case EmergencyAction.SUSPEND_ALL_SERVICES:
      case EmergencyAction.EMERGENCY_SHUTDOWN:
        return ['notifications', 'integrations', 'queues_operational'];
      case EmergencyAction.DISABLE_NOTIFICATIONS:
        return ['notifications'];
      case EmergencyAction.PAUSE_ALL_QUEUES:
        return ['queues_operational'];
      case EmergencyAction.SUSPEND_INTEGRATIONS:
        return ['integrations'];
      default:
        return [];
    }
  }

  private async assertControlAdmin(adminId: string): Promise<void> {
    const admin = await this.adminRepo.findOneBy({ id: adminId });
    if (!admin) {
      throw new ForbiddenException('Administrative principal not found');
    }
    if (
      admin.role !== AdminRole.SUPER_ADMIN &&
      admin.role !== AdminRole.ADMINISTRATOR
    ) {
      throw new ForbiddenException(
        'Role is not permitted to mutate operational controls',
      );
    }
  }

  private async getLockedControl(
    manager: EntityManager,
  ): Promise<OperationalControl> {
    const repo = manager.getRepository(OperationalControl);
    const existing = await repo.findOne({
      where: { id: 'system' },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) return existing;
    return repo.create({
      id: 'system',
      maintenanceActive: false,
      maintenanceReason: null,
      maintenanceStartedAt: null,
      maintenanceScheduledEnd: null,
      schedules: [],
      emergencies: {},
      services: {},
      pendingCanonicalActions: {},
      updatedBy: null,
    });
  }

  private async recordControlEvent(
    manager: EntityManager,
    control: OperationalControl,
    operation: string,
    actorId: string,
    reason: string,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>,
    targetId = 'system',
  ): Promise<string> {
    const id = randomUUID();
    const auditReference = `oce-${id}`;
    const repo = manager.getRepository(OperationalControlEvent);
    await repo.save(
      repo.create({
        id,
        controlId: targetId,
        operation,
        actorId: actorId.slice(0, 64),
        reason: (reason || 'unspecified').slice(0, 255),
        beforeState,
        afterState,
        auditReference,
        controlVersion: control.version ?? 0,
      }),
    );
    return auditReference;
  }

  private async persistServiceState(
    serviceKey: string,
    operational: boolean,
    adminId?: string,
    reason?: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const services = { ...(control.services ?? {}) };
      const previous = services[serviceKey] ?? true;
      services[serviceKey] = operational;
      control.services = services;
      if (adminId) control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      await this.recordControlEvent(
        manager,
        control,
        operational ? 'service_restore' : 'service_suspend',
        adminId ?? 'system',
        reason ?? `${serviceKey} ${operational ? 'restored' : 'suspended'}`,
        { operational: previous },
        { operational },
        serviceKey,
      );
      this.loadControlCache(control);
    });
  }

  // ──────────────────────────────────────────────
  //  SYSTEM STATUS
  // ──────────────────────────────────────────────

  async getSystemStatus(): Promise<SystemStatusResponse> {
    await this.reconcilePersistedState();

    const now = Date.now();
    const activeEmergencies: string[] = [];
    this.emergencyStates.forEach((state, action) => {
      if (!state.expiresAt || now < state.expiresAt) {
        activeEmergencies.push(action);
      }
    });

    return {
      maintenanceMode: this.maintenanceActive,
      emergencyActive: activeEmergencies.length > 0,
      activeEmergencies,
      queuesOperational: this.serviceStates.get('queues_operational') ?? true,
      notificationsEnabled: this.serviceStates.get('notifications') ?? true,
      integrationsOperational: this.serviceStates.get('integrations') ?? true,
      apiThrottlingActive: activeEmergencies.includes(
        EmergencyAction.ENABLE_API_THROTTLING,
      ),
      uptime: this.getUptime(),
      environment: getRuntimeEnvironment().NODE_ENV ?? 'development',
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
    const totalCompleted = allMetrics.reduce((sum, m) => sum + m.completed, 0);

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
      environment: getRuntimeEnvironment().NODE_ENV ?? 'development',
      timestamp: new Date().toISOString(),
    };
  }

  async getDetailedOperationalStats(): Promise<Record<string, unknown>> {
    await this.reconcilePersistedState();
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
        integrationsOperational: this.serviceStates.get('integrations') ?? true,
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
    await this.assertControlAdmin(adminId);
    let auditReference = '';
    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const before = {
        maintenanceActive: control.maintenanceActive,
        reason: control.maintenanceReason,
      };
      control.maintenanceActive = dto.enabled;
      control.maintenanceReason = dto.reason ?? null;
      control.maintenanceStartedAt = dto.enabled ? new Date() : null;
      control.maintenanceScheduledEnd = dto.scheduledEnd
        ? new Date(dto.scheduledEnd)
        : null;
      control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      auditReference = await this.recordControlEvent(
        manager,
        control,
        dto.enabled ? 'maintenance_enable' : 'maintenance_disable',
        adminId,
        dto.reason ?? 'maintenance state change',
        before,
        { maintenanceActive: dto.enabled, reason: dto.reason ?? null },
      );
      this.loadControlCache(control);
    });

    await this.auditTrailService.log({
      actionType: dto.enabled
        ? AuditActionType.MAINTENANCE_MODE_ENABLED
        : AuditActionType.MAINTENANCE_MODE_DISABLED,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: 'system',
      userId: adminId,
      severity: AuditSeverity.HIGH,
      category: AuditCategory.MAINTENANCE,
      description: dto.enabled
        ? `Maintenance mode enabled${dto.reason ? `: ${dto.reason}` : ''}`
        : 'Maintenance mode disabled',
      beforeState: { maintenanceActive: this.maintenanceActive },
      afterState: { maintenanceActive: dto.enabled, reason: dto.reason },
      metadata: { auditReference },
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
    await this.assertControlAdmin(adminId);

    if (dto.endTime && Date.parse(dto.endTime) <= Date.parse(dto.startTime)) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const schedule: MaintenanceSchedule = {
      id: `mnt-${Date.now()}-${randomUUID().slice(0, 8)}`,
      description: dto.description,
      startTime: dto.startTime,
      endTime: dto.endTime,
      status: 'scheduled',
      affectedServices: dto.affectedServices,
      createdAt: new Date().toISOString(),
      createdBy: adminId,
    };

    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const schedules = [
        ...((control.schedules ?? []) as unknown as MaintenanceSchedule[]),
      ];
      if (schedules.some((s) => s.id === schedule.id)) {
        throw new ConflictException(
          `Maintenance schedule ${schedule.id} already exists`,
        );
      }
      schedules.push(schedule);
      control.schedules = schedules as unknown as Record<string, unknown>[];
      control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      await this.recordControlEvent(
        manager,
        control,
        'maintenance_schedule',
        adminId,
        dto.description,
        { scheduleCount: schedules.length - 1 },
        { schedule },
        schedule.id,
      );
      this.loadControlCache(control);
    });

    await this.auditTrailService.log({
      actionType: AuditActionType.MAINTENANCE_SCHEDULED,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: schedule.id,
      userId: adminId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.MAINTENANCE,
      description: `Scheduled maintenance: ${dto.description}`,
      afterState: schedule,
    });

    this.logger.log(
      `Maintenance scheduled: ${schedule.id} - ${dto.description}`,
    );

    return schedule;
  }

  async cancelMaintenance(scheduleId: string, adminId: string): Promise<void> {
    await this.assertControlAdmin(adminId);

    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const schedules = [
        ...((control.schedules ?? []) as unknown as MaintenanceSchedule[]),
      ];
      const index = schedules.findIndex((s) => s.id === scheduleId);
      if (index === -1) {
        throw new NotFoundException(
          `Maintenance schedule ${scheduleId} not found`,
        );
      }
      const persistedSchedule = schedules[index];
      if (persistedSchedule.status !== 'scheduled') {
        throw new ConflictException(
          `Cannot cancel maintenance with status '${persistedSchedule.status}'`,
        );
      }
      schedules[index] = { ...persistedSchedule, status: 'cancelled' };
      control.schedules = schedules as unknown as Record<string, unknown>[];
      control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      await this.recordControlEvent(
        manager,
        control,
        'maintenance_cancel',
        adminId,
        persistedSchedule.description,
        { status: persistedSchedule.status },
        { status: 'cancelled' },
        scheduleId,
      );
      this.loadControlCache(control);
    });

    await this.auditTrailService.log({
      actionType: AuditActionType.MAINTENANCE_CANCELLED,
      entityType: AuditEntityType.MAINTENANCE,
      entityId: scheduleId,
      userId: adminId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.MAINTENANCE,
      description: `Cancelled maintenance schedule ${scheduleId}`,
      afterState: { status: 'cancelled' },
    });

    this.logger.log(`Maintenance schedule cancelled: ${scheduleId}`);
  }

  async getMaintenanceStatus(): Promise<MaintenanceStatusResponse> {
    await this.reconcilePersistedState();
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
    await this.assertControlAdmin(adminId);
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
            `Unknown service type: ${String(serviceType)}`,
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
      : [
          QueueName.DEFAULT,
          QueueName.NOTIFICATIONS,
          QueueName.BLOCKCHAIN,
          QueueName.ANALYTICS,
        ];

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
          throw new BadRequestException(
            `Unknown queue action: ${String(action)}`,
          );
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
    await this.persistServiceState(
      'notifications',
      !isSuspending,
      adminId,
      reason,
    );

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
    await this.persistServiceState(
      'integrations',
      !isSuspending,
      adminId,
      reason,
    );

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
    await this.persistServiceState(serviceKey, !isSuspending, adminId, reason);

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
      : [
          QueueName.DEFAULT,
          QueueName.NOTIFICATIONS,
          QueueName.BLOCKCHAIN,
          QueueName.ANALYTICS,
        ];

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
    await this.assertControlAdmin(adminId);
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

    const affectedServices = this.getAffectedServices(action);
    let auditReference = '';

    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const emergencies = {
        ...((control.emergencies ?? {}) as Record<string, EmergencyState>),
      };
      emergencies[action] = emergency;
      control.emergencies = emergencies;
      if (
        action === EmergencyAction.EMERGENCY_SHUTDOWN ||
        action === EmergencyAction.PAUSE_ALL_QUEUES
      ) {
        control.pendingCanonicalActions = {
          ...(control.pendingCanonicalActions ?? {}),
          [action]: {
            status: 'pending',
            reason,
            requestedBy: adminId,
            requestedAt: emergency.timestamp,
            canonicalEvidenceRequired: true,
          },
        };
      }
      control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      auditReference = await this.recordControlEvent(
        manager,
        control,
        'emergency_execute',
        adminId,
        reason,
        {},
        { action, expiresAt: emergency.expiresAt, affectedServices },
        `emergency-${action}`,
      );
      this.loadControlCache(control);
    });

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
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        affectedServices,
      },
      metadata: { auditReference },
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
    await this.assertControlAdmin(adminId);

    let resolved: EmergencyState | undefined;
    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const emergencies = {
        ...((control.emergencies ?? {}) as Record<string, EmergencyState>),
      };
      resolved = emergencies[action];
      if (!resolved) {
        throw new NotFoundException(`No active emergency action: ${action}`);
      }
      delete emergencies[action];
      control.emergencies = emergencies;
      control.updatedBy = adminId;
      await manager.getRepository(OperationalControl).save(control);
      await this.recordControlEvent(
        manager,
        control,
        'emergency_resolve',
        adminId,
        `Resolved emergency action ${action}`,
        resolved as unknown as Record<string, unknown>,
        { resolved: true },
        `emergency-${action}`,
      );
      this.loadControlCache(control);
    });

    await this.auditTrailService.log({
      actionType: AuditActionType.SERVICE_RESTORED,
      entityType: AuditEntityType.SERVICE,
      entityId: `emergency-${action}`,
      userId: adminId,
      severity: AuditSeverity.HIGH,
      category: AuditCategory.EMERGENCY,
      description: `Resolved emergency action: ${action}`,
      beforeState: resolved,
      afterState: { resolved: true, resolvedAt: new Date().toISOString() },
    });

    this.logger.log(`Emergency action resolved: ${action} by admin ${adminId}`);
  }

  async resolveCanonicalAction(
    action: string,
    evidence: {
      transactionHash?: string;
      ledger?: number;
      eventId?: string;
    },
    actorId: string,
  ): Promise<void> {
    await this.assertControlAdmin(actorId);

    await this.dataSource.transaction(async (manager) => {
      const control = await this.getLockedControl(manager);
      const pendingCanonical = {
        ...((control.pendingCanonicalActions ?? {}) as Record<
          string,
          Record<string, unknown>
        >),
      };
      const entry = pendingCanonical[action];
      if (!entry || entry.status !== 'pending') {
        throw new NotFoundException(`No pending canonical action: ${action}`);
      }
      pendingCanonical[action] = {
        ...entry,
        status: 'resolved',
        resolvedAt: new Date().toISOString(),
        resolvedBy: actorId,
        canonicalEvidence: evidence,
      };
      control.pendingCanonicalActions = pendingCanonical;
      control.updatedBy = actorId;
      await manager.getRepository(OperationalControl).save(control);
      await this.recordControlEvent(
        manager,
        control,
        'canonical_action_resolved',
        actorId,
        `Canonical evidence confirmed for ${action}`,
        { status: 'pending' },
        { status: 'resolved', evidence },
        action,
      );
      this.loadControlCache(control);
    });

    await this.auditTrailService.log({
      actionType: AuditActionType.EMERGENCY_ACTION_EXECUTED,
      entityType: AuditEntityType.SERVICE,
      entityId: `canonical-${action}`,
      userId: actorId,
      severity: AuditSeverity.HIGH,
      category: AuditCategory.EMERGENCY,
      description: `Canonical evidence confirmed for pending action: ${action}`,
      afterState: { action, evidence },
    });
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
    const beforeValue = await this.configService.get(dto.key, dto.environment);

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

  async evaluateFeatureFlag(key: string, context?: Record<string, unknown>) {
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
      const result = await this.dataSource.query<
        Array<{ count?: string | number }>
      >(`SELECT COUNT(*) as count FROM ${table}`);
      return Number(result[0]?.count ?? 0);
    } catch {
      return 0;
    }
  }

  private getUptime(): number {
    return Date.now() - this.startTime;
  }
}
