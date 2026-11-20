# Durable Protocol Operational Controls

`ProtocolAdminService` (`src/admin/protocol/protocol-admin.service.ts`) stores
all privileged operational controls — maintenance mode, scheduled maintenance,
emergency actions, service enablement, actor, reason, and audit references — in
the `operational_controls` table instead of process-local fields. In-memory
maps are a read cache only; every mutation is applied inside a transaction that
takes a `pessimistic_write` lock on the singleton `system` row, writes an
`operational_control_events` row, and reloads the cache from the persisted
state. A stale local map can never override the database.

## Persistence model

- `operational_controls` — one row (`id = 'system'`) holding:
  - `maintenanceActive`, `maintenanceReason`, `maintenanceStartedAt`,
    `maintenanceScheduledEnd`
  - `schedules` (jsonb): scheduled/active/completed/cancelled maintenance windows
  - `emergencies` (jsonb): active emergency actions with optional `expiresAt`
  - `services` (jsonb): manually administered service enablement
    (`notifications`, `integrations`, `queues_operational`, plus per-service keys)
  - `pendingCanonicalActions` (jsonb): actions that require on-chain protocol
    authority (e.g. `emergency_shutdown`, `pause_all_queues`). These remain
    `status: 'pending'` until canonical contract event/finality evidence marks
    them resolved. The API never grants itself protocol mutation authority.
  - `updatedBy`, optimistic `version` (`@VersionColumn`)
- `operational_control_events` — append-only audit of every control mutation:
  operation, actor, reason, before/after state, `controlVersion`, and an
  `auditReference` (`oce-<uuid>`) cross-linked from the `AuditLog` metadata.

Schema is created by migration
`src/migrations/1793200000000-AddDurableOperationalControls.ts`.

## Concurrency and reconciliation

- All mutations (`setMaintenanceMode`, `scheduleMaintenance`,
  `cancelMaintenance`, `controlService`, `executeEmergencyAction`,
  `resolveEmergencyAction`) run inside `dataSource.transaction` with a
  `pessimistic_write` lock on the control row, so concurrent admin actions are
  serialized and cannot produce conflicting state. Authorization is re-checked
  inside the service (`SUPER_ADMIN`/`ADMINISTRATOR` only) in addition to the
  controller role guards.
- `onModuleInit` and every status read call `reconcilePersistedState()`, which
  deterministically:
  - deletes expired emergency actions (`expiresAt <= now`),
  - transitions schedules (`scheduled → active → completed`) based on wall-clock
    time, healing state that changed while the process was down,
  - drops `pendingCanonicalActions` entries marked `resolved`.
- Effective service state is derived at cache-load time: persisted manual
  enablement AND suppression from every non-expired emergency. Resolving an
  emergency therefore cannot clobber an unrelated manual suspension.

## Failure behavior

Persistence failures abort the transaction and the API call fails closed — no
control change is reported as applied without a durable write and an
`operational_control_events` record. If the control row cannot be read at
startup, module initialization fails rather than running with divergent
in-memory state.

## Roles

Read endpoints allow `SUPER_ADMIN`, `ADMINISTRATOR`, `SECURITY_ANALYST`, and
`AUDITOR`. All mutations additionally require `SUPER_ADMIN` or
`ADMINISTRATOR`, enforced both by `@Roles` guards and `assertControlAdmin()`.
