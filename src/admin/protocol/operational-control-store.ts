import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { OperationalControl } from '../entities/operational-control.entity';
import { OperationalControlEvent } from '../entities/operational-control-event.entity';
import { CONTROL_ID } from './operational-control-state';

const ENSURE_CONTROL_ROW_SQL = `INSERT INTO "operational_controls" (
  "id", "maintenanceActive", "maintenanceReason", "maintenanceStartedAt",
  "maintenanceScheduledEnd", "schedules", "emergencies", "services",
  "pendingCanonicalActions", "updatedBy", "version", "createdAt", "updatedAt"
) VALUES (
  'system', false, NULL, NULL, NULL, '[]', '{}', '{}', '{}', NULL, 1, now(), now()
) ON CONFLICT ("id") DO NOTHING`;

export async function ensureOperationalControlRow(
  manager: EntityManager,
): Promise<void> {
  await manager.query(ENSURE_CONTROL_ROW_SQL);
}

export async function getLockedControl(
  manager: EntityManager,
): Promise<OperationalControl> {
  await ensureOperationalControlRow(manager);
  const repo = manager.getRepository(OperationalControl);
  const existing = await repo.findOne({
    where: { id: CONTROL_ID },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing) return existing;

  const created = repo.create({
    id: CONTROL_ID,
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
  return repo.save(created);
}

export async function recordControlEvent(
  manager: EntityManager,
  control: OperationalControl,
  operation: string,
  actorId: string,
  reason: string,
  beforeState: Record<string, unknown>,
  afterState: Record<string, unknown>,
  targetId = CONTROL_ID,
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
