import { BadRequestException } from '@nestjs/common';
import { EmergencyAction } from './dto/emergency.dto';

export interface EmergencyState {
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

export interface ControlStateLike {
  maintenanceActive: boolean;
  maintenanceReason?: string | null;
  maintenanceStartedAt?: Date | string | null;
  maintenanceScheduledEnd?: Date | string | null;
  schedules?: unknown[] | null;
  emergencies?: Record<string, unknown> | null;
  services?: Record<string, boolean> | null;
}

export const CONTROL_ID = 'system';

export const DEFAULT_SERVICE_STATES: Record<string, boolean> = {
  notifications: true,
  integrations: true,
  queues_operational: true,
};

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

export function hasOwnEntry(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return !!record && Object.hasOwn(record, key);
}

export function isCanonicalRequiredAction(action: string): boolean {
  const value = String(action);
  return (
    value === String(EmergencyAction.EMERGENCY_SHUTDOWN) ||
    value === String(EmergencyAction.PAUSE_ALL_QUEUES)
  );
}

export function isActiveEmergency(
  state: { expiresAt?: number } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!state) return false;
  return !state.expiresAt || state.expiresAt > now;
}

export function emergencyServiceKeys(action: string): string[] {
  switch (String(action)) {
    case String(EmergencyAction.SUSPEND_ALL_SERVICES):
    case String(EmergencyAction.EMERGENCY_SHUTDOWN):
      return ['notifications', 'integrations', 'queues_operational'];
    case String(EmergencyAction.DISABLE_NOTIFICATIONS):
      return ['notifications'];
    case String(EmergencyAction.SUSPEND_INTEGRATIONS):
      return ['integrations'];
    case String(EmergencyAction.PAUSE_ALL_QUEUES):
      return ['queues_operational'];
    default:
      return [];
  }
}

export function parseInstant(
  value: string | Date | null | undefined,
  requireOffset = true,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = value instanceof Date ? value.toISOString() : value;
  if (requireOffset && !OFFSET_SUFFIX.test(raw)) {
    throw new BadRequestException(
      'Timestamps must include an explicit UTC offset (Z or +HH:MM/-HH:MM)',
    );
  }
  const normalized =
    value instanceof Date || OFFSET_SUFFIX.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function normalizeInstant(
  value: string | Date | null | undefined,
  requireOffset = true,
): string | null {
  const parsed = parseInstant(value, requireOffset);
  return parsed === null ? null : new Date(parsed).toISOString();
}

export function advanceScheduleStatus(
  schedule: MaintenanceSchedule,
  now: number = Date.now(),
): MaintenanceSchedule['status'] {
  if (schedule.status !== 'scheduled' && schedule.status !== 'active') {
    return schedule.status;
  }
  const start = parseInstant(schedule.startTime, false);
  const end = parseInstant(schedule.endTime, false);
  const isDue = start !== null && start <= now;
  const isOver = end !== null && end <= now;
  if (isOver) return 'completed';
  if (isDue && schedule.status === 'scheduled') return 'active';
  return schedule.status;
}

export function getActiveEmergencies(
  control: ControlStateLike,
  now: number = Date.now(),
): EmergencyState[] {
  const emergencies = (control.emergencies ?? {}) as Record<
    string,
    EmergencyState
  >;
  return Object.values(emergencies).filter((state) =>
    isActiveEmergency(state, now),
  );
}

export function computeEffectiveServices(
  control: ControlStateLike,
  now: number = Date.now(),
): Record<string, boolean> {
  const services: Record<string, boolean> = {
    ...DEFAULT_SERVICE_STATES,
    ...(control.services ?? {}),
  };
  for (const emergency of getActiveEmergencies(control, now)) {
    for (const key of emergencyServiceKeys(emergency.action)) {
      services[key] = false;
    }
  }
  return services;
}

export function isNotificationsEnabled(
  control: ControlStateLike | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!control) return true;
  return computeEffectiveServices(control, now).notifications !== false;
}

export function isEmergencyMaintenanceActive(
  control: ControlStateLike,
  now: number = Date.now(),
): EmergencyState | undefined {
  return getActiveEmergencies(control, now).find(
    (state) => state.action === EmergencyAction.EMERGENCY_SHUTDOWN,
  );
}

export function computeEffectiveMaintenance(
  control: ControlStateLike,
  now: number = Date.now(),
): {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
} {
  if (control.maintenanceActive) {
    return {
      active: true,
      reason: control.maintenanceReason ?? null,
      startedAt: toIsoString(control.maintenanceStartedAt),
    };
  }
  const shutdown = isEmergencyMaintenanceActive(control, now);
  if (shutdown) {
    return {
      active: true,
      reason: shutdown.reason,
      startedAt: shutdown.timestamp,
    };
  }
  return { active: false, reason: null, startedAt: null };
}

export function isApiThrottlingActive(
  control: ControlStateLike,
  now: number = Date.now(),
): boolean {
  return getActiveEmergencies(control, now).some(
    (state) => state.action === EmergencyAction.ENABLE_API_THROTTLING,
  );
}

export function toIsoString(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function isEmergencyAction(value: string): boolean {
  return Object.values(EmergencyAction).includes(value as EmergencyAction);
}
