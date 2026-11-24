# PostgreSQL / TypeORM Migration Inventory
**Ticket:** PREWAVE-BE-010 (#605)

## Canonical path

- DataSource: `src/config/data-source.ts`
- Canonical migrations glob: `src/database/migrations/*.ts`
- Secondary / historical set (NOT loaded by DataSource): `src/migrations/`
- Decision: **Canonical set = `src/database/migrations/`**

## Ordering rules

1. Ordered by numeric timestamp prefix in the filename.
2. Same timestamp: lexicographic by full filename.
3. TypeORM tracks applied migrations in the `migrations` table.

## Inventory — canonical (`src/database/migrations/`)

| # | Timestamp | File | Purpose | Destructive? | Expand/Contract |
|---|-----------|------|---------|--------------|-----------------|
| 1 | 1725000000000 | V2Baseline.ts | V2 baseline schema | No | Expand |
| 2 | 1725000001000 | SafeRemovedLogsAndBlocks.ts | Safe removal of logs/blocks | Review | Contract? |
| 3 | 1725000002000 | CreateV2FinalizedCursors.ts | V2 finalized cursors | No | Expand |
| 4 | 1792200000000 | PersistAdministrativeAudit.ts | Administrative audit | No | Expand |

Supporting (not migrations): migration-safety.ts, migration-validator.service.ts, migration-safety.spec.ts

## Secondary set

`src/migrations/` is historical and NOT loaded by DataSource.

## Acceptance linkage

Fresh install = N-1 schema; failed migration recovery; destructive evidence; restore preserves cursor + audit.# PostgreSQL / TypeORM Migration Inventory
**Ticket:** PREWAVE-BE-010 (#605)

## Canonical path

- DataSource: `src/config/data-source.ts`
- Canonical migrations glob: `src/database/migrations/*.ts`
- Secondary / historical set (NOT loaded by DataSource): `src/migrations/`
- Decision: **Canonical set = `src/database/migrations/`**

## Ordering rules

1. Ordered by numeric timestamp prefix in the filename.
2. Same timestamp: lexicographic by full filename.
3. TypeORM tracks applied migrations in the `migrations` table.

## Inventory — canonical (`src/database/migrations/`)

| # | Timestamp | File | Purpose | Destructive? | Expand/Contract |
|---|-----------|------|---------|--------------|-----------------|
| 1 | 1725000000000 | V2Baseline.ts | V2 baseline schema | No | Expand |
| 2 | 1725000001000 | SafeRemovedLogsAndBlocks.ts | Safe removal of logs/blocks | Review | Contract? |
| 3 | 1725000002000 | CreateV2FinalizedCursors.ts | V2 finalized cursors | No | Expand |
| 4 | 1792200000000 | PersistAdministrativeAudit.ts | Administrative audit | No | Expand |

Supporting (not migrations): migration-safety.ts, migration-validator.service.ts, migration-safety.spec.ts

## Secondary set

`src/migrations/` is historical and NOT loaded by DataSource.



## Acceptance linkage

Fresh install = N-1 schema; failed migration recovery; destructive evidence; restore preserves cursor + audit.
