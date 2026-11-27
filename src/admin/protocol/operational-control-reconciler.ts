import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { OperationalControl } from '../entities/operational-control.entity';
import { findFinalizedEvidence } from './canonical-evidence';
import {
  advanceScheduleStatus,
  CONTROL_ID,
  EmergencyState,
  isActiveEmergency,
  isCanonicalRequiredAction,
  MaintenanceSchedule,
  normalizeInstant,
  parseInstant,
} from './operational-control-state';
import {
  getLockedControl,
  recordControlEvent,
} from './operational-control-store';

interface PendingCanonicalEntry {
  action?: string;
  requestId?: string;
  status?: string;
  [key: string]: unknown;
}

interface TransitionEvent {
  operation: string;
  reason: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  targetId: string;
}

@Injectable()
export class OperationalControlReconciler implements OnModuleInit {
  private readonly logger = new Logger(OperationalControlReconciler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(IndexedEvent)
    private readonly indexedEventRepo: Repository<IndexedEvent>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcileFromSchedule(): Promise<void> {
    await this.reconcile();
  }

  async reconcile(): Promise<OperationalControl | null> {
    let reconciled: OperationalControl | null = null;

    await this.dataSource.transaction(async (manager) => {
      const control = await getLockedControl(manager);
      const now = Date.now();
      const events: TransitionEvent[] = [];
      let dirty = false;

      const emergencies = {
        ...((control.emergencies ?? {}) as Record<string, EmergencyState>),
      };
      for (const [action, state] of Object.entries(emergencies)) {
        if (!isActiveEmergency(state, now)) {
          delete emergencies[action];
          events.push({
            operation: 'emergency_expire',
            reason: `Emergency ${action} expired`,
            before: { action, expiresAt: state.expiresAt },
            after: { action, status: 'expired' },
            targetId: `emergency-${action}`,
          });
          dirty = true;
        }
      }
      control.emergencies = emergencies;

      if (
        control.maintenanceActive &&
        control.maintenanceScheduledEnd &&
        (parseInstant(control.maintenanceScheduledEnd, false) ?? Infinity) <=
          now
      ) {
        events.push({
          operation: 'maintenance_auto_disable',
          reason: 'Scheduled maintenance end reached',
          before: {
            maintenanceActive: true,
            maintenanceScheduledEnd: toIso(control.maintenanceScheduledEnd),
          },
          after: { maintenanceActive: false, maintenanceScheduledEnd: null },
          targetId: CONTROL_ID,
        });
        control.maintenanceActive = false;
        control.maintenanceReason = null;
        control.maintenanceStartedAt = null;
        control.maintenanceScheduledEnd = null;
        dirty = true;
      }

      const schedules = [
        ...((control.schedules ?? []) as unknown as MaintenanceSchedule[]),
      ];
      for (const schedule of schedules) {
        const startTime = normalizeInstant(schedule.startTime, false);
        const endTime = normalizeInstant(schedule.endTime, false);
        if (startTime && startTime !== schedule.startTime) {
          schedule.startTime = startTime;
          dirty = true;
        }
        if (endTime && schedule.endTime && endTime !== schedule.endTime) {
          schedule.endTime = endTime;
          dirty = true;
        }
        const nextStatus = advanceScheduleStatus(schedule, now);
        if (nextStatus !== schedule.status) {
          events.push({
            operation:
              nextStatus === 'active'
                ? 'schedule_activate'
                : 'schedule_complete',
            reason: `Maintenance schedule ${schedule.id} became ${nextStatus}`,
            before: { id: schedule.id, status: schedule.status },
            after: { id: schedule.id, status: nextStatus },
            targetId: schedule.id,
          });
          schedule.status = nextStatus;
          dirty = true;
        }
      }
      control.schedules = schedules as unknown as Record<string, unknown>[];

      const pendingCanonical = {
        ...((control.pendingCanonicalActions ?? {}) as Record<
          string,
          PendingCanonicalEntry
        >),
      };
      for (const [requestId, entry] of Object.entries(pendingCanonical)) {
        if (entry.status === 'resolved') {
          delete pendingCanonical[requestId];
          dirty = true;
          continue;
        }
        if (entry.status !== 'pending' || !entry.action) continue;
        if (!isCanonicalRequiredAction(String(entry.action))) continue;

        const evidence = await this.findEvidence(
          manager,
          String(entry.action),
          {
            requestId,
          },
        );
        if (!evidence) continue;

        pendingCanonical[requestId] = {
          ...entry,
          status: 'resolved',
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'system',
          canonicalEvidence: evidence,
        };
        events.push({
          operation: 'canonical_action_resolved',
          reason: `Finalized canonical evidence confirmed for ${String(entry.action)}`,
          before: { requestId, action: entry.action, status: 'pending' },
          after: {
            requestId,
            action: entry.action,
            status: 'resolved',
            evidence,
          },
          targetId: String(entry.action),
        });
        dirty = true;
      }
      for (const [requestId, entry] of Object.entries(pendingCanonical)) {
        if (entry.status === 'resolved') delete pendingCanonical[requestId];
      }
      control.pendingCanonicalActions = pendingCanonical;

      if (dirty) {
        control.updatedAt = new Date();
        const saved = await manager
          .getRepository(OperationalControl)
          .save(control);
        Object.assign(control, saved);
        for (const event of events) {
          await recordControlEvent(
            manager,
            control,
            event.operation,
            'system',
            event.reason,
            event.before,
            event.after,
            event.targetId,
          );
        }
      }

      reconciled = control;
    });

    return reconciled;
  }

  private async findEvidence(
    manager: EntityManager,
    action: string,
    filters: { requestId: string },
  ) {
    const repo = manager.getRepository(IndexedEvent) ?? this.indexedEventRepo;
    try {
      return await findFinalizedEvidence(repo, action, filters);
    } catch (error) {
      this.logger.warn(
        `Canonical evidence lookup failed: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
