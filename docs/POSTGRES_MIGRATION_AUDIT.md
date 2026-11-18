# PostgreSQL Migration Audit (PR #896)

**Audit basis:** source tree at PR head `95bf0a8db97986b4a9a2cc0352c2dbef78d767c3` and GitHub Actions run `44403186120` (merge ref based on the preceding PR head). This is a repository/source audit, not evidence of any deployed database's migration state.

## Current validation status

The first completed `Schema Migration and Drift Gate` run failed before executing migration SQL. TypeORM CLI compilation stopped on unresolved `NotificationChannel` references in `src/notifications/entities/notification.entity.ts`. The branch source at the newer audited head imports `DeliveryChannel as NotificationChannel` from `src/notifications/interfaces/notification.types.ts`; rerun the gate on that exact head before concluding this compile issue is resolved.

Because the command failed before migration discovery/execution, that run establishes **no** result for PostgreSQL SQL compatibility, migration ordering, entity/schema drift, rollback, or reapply.

## Confirmed source-level migration risks

### SQLite-specific SQL in historical migrations

- `1704067200000-AddAuditLogs.ts` uses `LOWER(HEX(RANDOMBLOB(16)))` as a default expression and declares a `datetime` column. These are SQLite-oriented and not portable PostgreSQL definitions.
- `1769700000000-CreateAiAssistantTables.ts` uses `datetime('now')`, `datetime` column types, and integer boolean defaults (`0` / `1`). These statements need PostgreSQL-compatible definitions if they are to run on a fresh PostgreSQL database.

### Duplicate migration timestamps

The following timestamp prefixes are duplicated:

| Timestamp | Files |
| --- | --- |
| `1769600000000` | `AddClaimResolvedAt`, `AddEvidenceVersionColumns` |
| `1769700000000` | `AddResolvedAtToClaims`, `CreateAiAssistantTables` |
| `1769800000000` | `AddEvidenceRegistrationColumns`, `CreateV2CanonicalEventTables` |
| `1790000000000` | `AddAuditLogHashChain`, `AddDeploymentBlockToContractArtifact`, `AddUserRoleToUsers` |
| `1792400000000` | `AddEventCheckpointHashes`, `CreatePublicIncidentProjections` |

The `AddUserRoleToUsers.spec.ts` test file shares the `1790000000000` prefix but is excluded by the CLI migration glob `src/migrations/!(*.spec).ts`.

Duplicate timestamps are a deterministic-ordering and history-review risk, but are not by themselves proof of a migration failure. Do not rename already-deployed migration classes/files or rewrite historical migrations until applied migration records and dependency ordering are known.

### Duplicate column change

Both `1769600000000-AddClaimResolvedAt.ts` and `1769700000000-AddResolvedAtToClaims.ts` modify `claims.resolvedAt`. The earlier migration also backfills from `resolvedVerdict` and creates an index; the later migration uses `ADD COLUMN IF NOT EXISTS`. Their combined behavior and rollback semantics need verification against existing migration records and live schema.

## Required evidence before choosing a compatibility strategy

For every deployed environment (production, staging, preview, or any long-lived customer database), obtain a read-only export of:

1. TypeORM migration table rows (migration class/name and timestamp), ordered by timestamp and name.
2. The actual database engine/version and current schema for affected tables.
3. Whether the audit-log and AI-assistant tables/columns already exist, including defaults and indexes.
4. The release/commit that last applied migrations.

Do not provide credentials. A sanitized schema-only dump and migration-table export are sufficient. If there are no deployed TypeORM databases, record that explicitly; the fresh-database baseline can then be repaired independently.

## Safe repair sequence

1. Make TypeORM CLI compilation deterministic and green on the exact PR head.
2. Run the unmodified migration chain against disposable PostgreSQL and capture the first SQL error.
3. Establish each deployed database's migration ledger before any historical file is changed.
4. Preserve immutable history for databases that may have applied it. Where required, add a forward-only PostgreSQL repair migration that is safe for both recorded and partially provisioned schemas, with explicit preconditions and postconditions.
5. For fresh databases, define a reviewed baseline/compatibility strategy that preserves the same final schema without silently marking unapplied history as complete.
6. Make duplicate-timestamp execution order explicit and test it. Do not rely on incidental filesystem/glob ordering.
7. Test fresh install, upgrade from each known deployed migration state, idempotent precondition handling, rollback policy, entity/schema drift, and data-preservation invariants.

## Separate build/type-check blocker

The Container Smoke Build at this head fails in `npm run type-check`. Reported failures include stale `CanonicalEvent` test fixtures, `EventCheckpoint.lastIndexedBlock` usage despite that property not existing on the entity, missing `BlockchainStateService.getIndexerHealth` and older reorg helper methods, and an OpenAPI fixture/test API mismatch. These are contract/test alignment issues; do not weaken the compiler or remove checks to get a green image.

## Explicit non-claims

- No deployed migration ledger has been inspected.
- No migration has been applied to a production or staging database.
- PostgreSQL migration compatibility, entity/schema parity, and application startup are not yet validated.
- Prisma remains in use and must not be removed until all consumers and data-parity checks are addressed.
