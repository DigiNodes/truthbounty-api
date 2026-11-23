# Durable Protocol Operational Controls

`ProtocolAdminService` (`src/admin/protocol/protocol-admin.service.ts`) stores
all privileged operational controls — maintenance mode, scheduled maintenance,
emergency actions, service enablement, actor, reason, and audit references — in
the `operational_controls` table instead of process-local fields. In-memory
maps are a read cache only; every mutation is applied inside a transaction that
takes a `pessimistic_write` lock on the singleton `system` row, writes an
`operational_control_events` row, and reloads the cache from the persisted
state after the transaction commits. A stale local map can never override the
database. `OperationalControlReconciler` is a request-independent singleton that
owns startup and periodic reconciliation.

## Persistence model

- `operational_controls` — one row (`id = 'system'`) holding:
  - `maintenanceActive`, `maintenanceReason`, `maintenanceStartedAt`,
    `maintenanceScheduledEnd`
  - `schedules` (jsonb): scheduled/active/completed/cancelled maintenance windows
  - `emergencies` (jsonb): active emergency actions with optional `expiresAt`
  - `services` (jsonb): manually administered service enablement
    (`notifications`, `integrations`, `queues_operational`, plus per-service keys)
  - `pendingCanonicalActions` (jsonb): keyed by immutable request id. Actions
    that require on-chain protocol authority (e.g. `emergency_shutdown`,
    `pause_all_queues`) remain `status: 'pending'` until a finalized canonical
    event carrying the same request id resolves that exact request. The API
    never grants itself protocol mutation authority.
  - `updatedBy`, optimistic `version` (`@VersionColumn`)
- `operational_control_events` — append-only audit of every control mutation:
  operation, actor, reason, before/after state, `controlVersion`, and an
  `auditReference` (`oce-<uuid>`) cross-linked from the `AuditLog` metadata.

Schema is shipped through the supported Prisma migration stream at
`prisma/migrations/20261120000000_add_durable_operational_controls/migration.sql`.
The matching TypeORM migration
`src/migrations/1793200000000-AddDurableOperationalControls.ts` is retained for
TypeORM-based environments. Both seed the `system` row so the first mutation
always locks an existing row.

## Concurrency and reconciliation

- All mutations (`setMaintenanceMode`, `scheduleMaintenance`,
  `cancelMaintenance`, `controlService`, `executeEmergencyAction`,
  `resolveEmergencyAction`) run inside `dataSource.transaction` with a
  `pessimistic_write` lock on the control row, so concurrent admin actions are
  serialized and cannot produce conflicting state. Authorization is re-checked
  inside the service (`SUPER_ADMIN`/`ADMINISTRATOR` only) in addition to the
  controller role guards.
- `OperationalControlReconciler.onModuleInit()` and a one-minute cron call
  `reconcile()`, which deterministically:
  - deletes expired emergency actions (`expiresAt <= now`),
  - clears manually enabled maintenance once `maintenanceScheduledEnd` passes,
  - transitions schedules (`scheduled → active → completed`) based on wall-clock
    time, healing state that changed while the process was down,
  - resolves request-bound canonical actions only from finalized `IndexedEvent`
    evidence matching the request id,
  - writes a system-actor `operational_control_events` row for each automatic
    transition. No-change reconciliation writes no events.
- Maintenance schedule boundaries must include an explicit UTC offset
  (`Z` or `+HH:MM/-HH:MM`) and are normalized to ISO-8601 UTC before persistence.
- Effective service state is derived at cache-load time: persisted manual
  enablement AND suppression from every non-expired emergency. Resolving an
  emergency therefore cannot clobber an unrelated manual suspension. Effective
  maintenance also includes an active `emergency_shutdown` without changing the
  manually persisted setting.
- Notification workers re-read the effective notifications control from the
  database before acquiring the delivery idempotency lock via
  `NotificationDispatchControlGuard`; queued jobs cannot bypass a persisted
  disable, and suppression does not consume the delivery idempotency key. The
  guard fails closed when the singleton control row is missing.

## Failure behavior

Persistence failures abort the transaction and the API call fails closed — no
control change is reported as applied without a durable write and an
`operational_control_events` record. If the control row cannot be read at
startup, module initialization fails rather than running with divergent
in-memory state.

## Canonical resolution

`POST /api/v1/admin/protocol/canonical-actions/resolve` accepts `action`,
`requestId`, `transactionHash`, optional `ledger`, and optional `eventId`. The
service resolves only the pending request whose immutable `requestId` matches,
and only when a finalized indexed event carries that exact request id, matches
the pending action, and matches the provided transaction/ledger/event filters.
The action response reports `canonicalStatus: 'pending'` and
`canonicalRequestId` until resolution; the resolve response returns the
confirmed evidence.

## Roles

Read endpoints allow `SUPER_ADMIN`, `ADMINISTRATOR`, `SECURITY_ANALYST`, and
`AUDITOR`. All mutations additionally require `SUPER_ADMIN` or
`ADMINISTRATOR`, enforced both by `@Roles` guards and `assertControlAdmin()`.
