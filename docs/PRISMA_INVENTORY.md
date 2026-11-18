# Prisma Inventory and TypeORM Convergence Status

**Revalidated:** 2026-11-18  
**Target architecture:** TypeORM + PostgreSQL only  
**Status:** Transitional; Prisma remains active and the API is not yet TypeORM-only.

This report supersedes earlier inventory statements where they conflict with the
2026-11-18 source revalidation. In particular, earlier claims that CI already exercised
TypeORM migrations, that the TypeORM migration path was unavailable only because of a
missing naming-strategy package, and that the architecture decision remained unresolved
are stale.

## Maintainer decision

TypeORM/PostgreSQL is the selected single persistence architecture. The conflicting
Prisma-only direction in issue #392 is superseded by this decision.

This is an architectural target, not a claim about the current runtime. Do not remove
Prisma, its generated client, or its historical migrations until every active call site has
been ported, data parity is proven, and the replacement has passed PostgreSQL integration
tests. No migration or data-retention history is to be discarded as part of this work.

See [PERSISTENCE_CONVERGENCE.md](./PERSISTENCE_CONVERGENCE.md) for the phased plan and
completion gates.

## Verified current state

### Application bootstrap and database configuration

- `src/app.module.ts` currently registers the global `PrismaModule`.
- `src/prisma/prisma.service.ts` extends the generated Prisma client and constructs it
  with `PrismaLibSql` from `@prisma/adapter-libsql`.
- That service passes `getRuntimeEnvironment().DATABASE_URL` to the LibSQL adapter.
  The runtime schema validates `DATABASE_URL` as a PostgreSQL URL. This is an invalid
  configuration contract: the same variable is interpreted as PostgreSQL by TypeORM and
  as a LibSQL connection by Prisma.
- `src/database/database.module.ts` contains TypeORM/PostgreSQL infrastructure, including
  connection pooling, repository injection, transaction helpers, readiness, and migration
  services. It is not currently registered by `AppModule`.
- `src/config/data-source.ts` is the standalone TypeORM CLI datasource. In this
  convergence branch it is PostgreSQL-only, disables schema synchronization, and targets
  the actual `src/migrations/*.ts` directory.
- The legacy `migration:run`, `migration:generate`, `migration:revert`, and
  `migration:status` package scripts still invoke Prisma. This branch adds explicit
  `typeorm:migration:*` scripts rather than silently changing the meaning of existing
  deployment commands before the migration histories are reconciled.
- `.github/workflows/ci.yml` currently runs `prisma migrate reset` and
  `prisma migrate deploy`. It does not yet prove that the TypeORM migration history can
  initialize an empty PostgreSQL database.

### Active Prisma runtime call sites

Prisma is not dead code. The previously reviewed inventory identifies active production
use in these domains:

| Domain | Representative use |
| --- | --- |
| Identity | User and Wallet persistence, transactions, World ID verification |
| Auth | Wallet lookup |
| Analytics | User, conversation, and message aggregates |
| Outbox | Outbox event persistence |
| Notifications | Outbox delivery persistence |
| Sybil resistance | User and Sybil score persistence |
| AI Assistant | Conversations, messages, usage metrics, and RAG documents |

Additional Prisma references exist in V2 services and test helpers, including block cursor,
chain-event deduplication, claim projection, dead-letter replay, AI Assistant e2e setup, and
authentication fixtures. The complete call-site inventory must be re-run from the current
head before any package or generated-client removal.

The generated client under `src/generated/client/`, `prisma/schema.prisma`,
`prisma.config.ts`, and `prisma/migrations/` remain active or historically significant.
The four recorded Prisma migrations must be retained until the deployed-data history is
reconciled with the canonical PostgreSQL schema.

## Changes made in this convergence branch

1. `src/config/data-source.ts` now exposes a testable
   `buildDataSourceOptions` function and supports PostgreSQL only. It uses
   `DATABASE_URL` when supplied, otherwise the documented PostgreSQL host/port/user
   settings. It rejects invalid ports, disables `synchronize`, and points at
   `src/migrations/*.ts`. The silent SQLite fallback is removed.
2. `src/config/data-source.spec.ts` adds focused tests for PostgreSQL-only selection,
   URL configuration, migration path, and invalid-port rejection.
3. `package.json` adds explicit `typeorm:migration:*` commands. Existing Prisma
   migration scripts are intentionally retained until their replacement is validated.
4. `src/app.module.ts` now describes Prisma wiring as transitional and explicitly
   prohibits removing it before its active call sites are migrated.
5. `docs/PERSISTENCE_CONVERGENCE.md` records the architecture decision, sequence, and
   completion gates.

These are Phase 0 changes. They do not register TypeORM as the application runtime, migrate
Prisma-backed domains, reconcile migration histories, or prove PostgreSQL startup.

## Required follow-up

1. Run the focused datasource tests, typecheck, and CI on the convergence branch.
2. Make the TypeORM/PostgreSQL configuration the actual application runtime. Do not leave
   both ORMs competing to own the same records.
3. Migrate each Prisma-backed domain with entity mapping, transaction/constraint parity,
   PostgreSQL integration tests, and a documented data-backfill plan.
4. Replace Prisma-specific e2e database helpers with disposable PostgreSQL fixtures.
5. Validate TypeORM migrations from an empty PostgreSQL database and compare the resulting
   schema with TypeORM entities. Audit timestamp collisions and migration ordering before
   treating the migration history as safe.
6. Remove Prisma runtime imports, generated output, CLI tooling, and packages only after
   the repository-wide search and dependency graph prove they are no longer required.
7. Preserve historical migration files unless a separate, explicit data-retention decision
   authorizes archival or removal.

## Release gate

The API is **not release-ready** on the basis of this work. Completion requires a clean
lockfile install, generated-config check, TypeScript build, application bootstrap against
disposable PostgreSQL, TypeORM migration apply/drift validation, unit/integration/e2e tests,
container build/runtime smoke, and a repository-wide proof that Prisma is no longer an
active dependency.
