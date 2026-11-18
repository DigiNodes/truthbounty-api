# Persistence Convergence: TypeORM/PostgreSQL

**Decision recorded:** 2026-11-18  
**Status:** In progress — the repository is not yet TypeORM-only.

## Decision

TypeORM with PostgreSQL is the single target persistence architecture. Prisma is a
transitional runtime dependency and must be removed only after every production call site,
test helper, generated artifact, and deployment path has been migrated and verified.

This decision supersedes the conflicting Prisma-only direction previously recorded in
issue #392. It does not authorize dropping Prisma tables, migration history, or production
data. Historical Prisma migrations remain evidence and must be reconciled with the live
PostgreSQL schema before they are retired.

## Verified starting state

The current source tree has two incompatible persistence paths:

- `src/app.module.ts` registers the global `PrismaModule`.
- `src/prisma/prisma.service.ts` constructs `PrismaClient` with
  `PrismaLibSql`, while passing it `DATABASE_URL`. The runtime schema restricts
  `DATABASE_URL` to PostgreSQL schemes. This adapter/configuration pairing is not a
  valid PostgreSQL runtime contract.
- `src/database/database.module.ts` contains a TypeORM/PostgreSQL connection,
  repository infrastructure, pool configuration, and migration services, but it is not
  currently registered by `AppModule`.
- `src/config/data-source.ts` is the standalone TypeORM CLI datasource. It previously
  had a SQLite fallback and pointed at a stale migration directory. This branch changes
  it to PostgreSQL-only, disables schema synchronization, and points it at the actual
  `src/migrations/` directory.
- Prisma is still used by production services in Identity, Auth, Analytics, Outbox,
  Notifications, Sybil Resistance, and AI Assistant. Those call sites are not dead code.

## Non-negotiable invariants

1. PostgreSQL is the only persistent database engine for application, test, and migration
   paths. No silent SQLite/LibSQL fallback.
2. TypeORM entities and committed TypeORM migrations are the canonical schema.
3. `DATABASE_URL` always means a PostgreSQL connection string. No ORM may reinterpret it.
4. Production schema changes are migration-only. `synchronize` stays disabled.
5. No Prisma dependency or generated client is removed until all runtime and test imports
   have been migrated and the replacement has passed parity tests.
6. Existing records and migration history must be preserved. No destructive reset against
   any shared or production database.
7. CI must validate the exact same PostgreSQL schema path used by the application.

## Migration sequence

### Phase 0 — make the target contract explicit

- [x] Record TypeORM/PostgreSQL as the selected target.
- [x] Mark Prisma application wiring as transitional rather than claiming it is the
      authoritative PostgreSQL implementation.
- [x] Make the TypeORM CLI datasource PostgreSQL-only and point it to `src/migrations/`.
- [x] Add focused tests for the TypeORM datasource contract.
- [ ] Run the focused tests and full CI on the resulting branch.

### Phase 1 — make TypeORM the actual application runtime

- Register and validate the TypeORM `DatabaseModule` in the application bootstrap.
- Resolve configuration ownership so the app and CLI use the same PostgreSQL connection
  contract and pool limits.
- Do not run both ORMs as competing owners of the same records.
- Keep Prisma-backed services available only behind an explicitly documented migration
  boundary until their TypeORM replacements are ready; do not claim convergence yet.

### Phase 2 — migrate feature contracts and data

Migrate one bounded domain at a time, with tests and schema parity evidence:

1. User and Wallet (Identity/Auth), including World ID verification and role fields.
2. Sybil scores and related provenance.
3. Analytics conversations, messages, and usage metrics.
4. Outbox events and notification delivery.
5. AI Assistant conversations, messages, usage metrics, and RAG documents.
6. Remaining Prisma-backed block cursor, chain-event, claim, and protocol services.

For each domain: map Prisma models to TypeORM entities, verify indexes/constraints,
preserve transaction and uniqueness semantics, add integration tests against disposable
PostgreSQL, and document any data backfill or dual-read/dual-write period. No feature is
considered migrated merely because TypeScript compiles.

### Phase 3 — remove Prisma only after proof

- Remove Prisma module wiring and all runtime imports.
- Replace Prisma-specific test utilities and e2e database setup with PostgreSQL-backed
  TypeORM fixtures.
- Remove generated Prisma client output, Prisma schema/configuration, and Prisma packages.
- Retain historical migration files and a documented archival record unless a separate,
  explicit data-retention decision authorizes their removal.
- Search the complete repository and dependency graph to prove no active Prisma dependency
  remains.

## Completion gates

The architecture is not complete until all of these pass on the same commit:

- clean dependency install from the committed lockfile;
- runtime configuration generation/check;
- TypeScript typecheck and application build;
- application bootstrap against disposable PostgreSQL;
- TypeORM migration apply, schema-drift check, rollback/reapply where supported;
- unit, integration, and e2e suites against PostgreSQL;
- data-parity checks for migrated records and constraints;
- container build and runtime smoke test;
- repository-wide Prisma reference/dependency audit showing only intentional historical
  references remain.

## Current limitations

This branch is only Phase 0. It does not yet register TypeORM in the application, migrate
the Prisma-backed domains, reconcile the two migration histories, or prove a clean
PostgreSQL runtime. The API must remain unreleasable until the completion gates above pass.
