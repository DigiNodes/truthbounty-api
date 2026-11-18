# ADR-001: TypeORM-only persistence for the TruthBounty API

- **Status:** Accepted
- **Decision date:** 2026-11-18
- **Decision owner:** Repository maintainer
- **Scope:** API runtime persistence, schema ownership, migrations, tests, and CI

## Decision

TypeORM is the sole persistence authority for the TruthBounty API. PostgreSQL is the canonical production database. The runtime application, CLI tools, migration tooling, integration tests, and CI must use the same TypeORM entity metadata and migration history.

Prisma must be removed from the runtime and toolchain only after every active Prisma consumer has been migrated and the replacement behavior is covered by tests. Until then, the repository is in a transitional state and must not claim TypeORM-only readiness.

No new Prisma models, Prisma migrations, Prisma service dependencies, or Prisma-backed feature work may be introduced.

## Evidence at decision time

At the current recovery branch head:

- `src/app.module.ts` now imports both `DatabaseModule` and `PrismaModule` explicitly. TypeORM was previously bootstrapped indirectly through `HealthModule`; the explicit root import removes that hidden dependency. Prisma remains temporarily wired because feature services still depend on it.
- `src/prisma/prisma.service.ts` still constructs `PrismaLibSql` with `DATABASE_URL` (or a local SQLite file), so it remains incompatible with the PostgreSQL URL supplied by CI.
- `prisma/schema.prisma` declares `provider = "postgresql"`. The Prisma schema and the LibSQL adapter therefore describe incompatible database paths.
- `src/database/database.module.ts` and `src/config/data-source.ts` provide the TypeORM PostgreSQL runtime and CLI infrastructure. The CLI datasource now targets the actual `src/migrations/*.ts` directory and PostgreSQL only.
- Multiple feature services still inject `PrismaService`; this is active application behavior, not dead code. Examples include identity, authentication, outbox, notifications, Sybil resistance, AI assistant/RAG, and V2 block cursor/chain-event deduplication.
- TypeORM entities and repositories are already used throughout the application. A partial ORM switch would leave two live persistence systems and is not an acceptable end state.

These facts mean that simply deleting Prisma or swapping the global module would break application startup or data access. The conversion must be staged and verified.

## Required invariants

1. Exactly one runtime ORM and one migration history own application data.
2. Production persistence is PostgreSQL; SQLite is not an implicit production or runtime fallback.
3. Every persistent model has one authoritative TypeORM entity mapping and a committed migration.
4. Services use TypeORM repositories or the shared transaction abstractions; no Prisma client calls remain.
5. Cross-entity atomic operations use a single TypeORM transaction manager/query runner.
6. Tests exercise PostgreSQL behavior for migrations, constraints, locking, JSON, and transaction semantics. In-memory SQLite tests may remain only where they are explicitly unit-level and do not stand in for PostgreSQL integration coverage.
7. CI provisions a disposable PostgreSQL database and runs the same TypeORM migration path used by deployment.
8. Prisma packages, generated clients, schema, migrations, scripts, and test helpers are removed only after a repository-wide reference audit returns zero active references.

## Migration sequence

### Phase 0 — Establish a reproducible TypeORM baseline

- Keep the existing PostgreSQL TypeORM data source and `DatabaseModule` as the target.
- Make the CLI data source, runtime module, migration globs, naming strategy, pool settings, and entity globs agree.
- CI now invokes the TypeORM migration CLI against its disposable PostgreSQL service (apply, show, revert, and reapply) instead of resetting and deploying the Prisma migration history.
- The first legacy TypeORM migration currently contains SQLite-specific SQL (`RANDOMBLOB`, `HEX`, and `datetime`); the PostgreSQL gate is expected to expose this incompatibility. Do not rewrite historical migrations without a reviewed forward-only compatibility strategy.
- Resolve missing or mismatched TypeORM dependencies and prove a clean PostgreSQL database can apply all committed TypeORM migrations.
- Verify migration generation reports no schema drift against entity metadata.
- Remove Prisma migration commands from the required CI path; do not weaken or skip the TypeORM migration gate.
- Do not remove Prisma runtime wiring yet.

### Phase 1 — Convert Prisma-backed feature areas

Convert each active consumer to TypeORM entities/repositories with behavior-preserving tests. Initial inventory:

- Identity and wallet linking, including transaction and uniqueness behavior.
- Authentication wallet lookup.
- World ID verification.
- Sybil score persistence and provenance.
- Outbox and notification delivery persistence.
- AI conversations, messages, usage metrics, and RAG context documents.
- V2 block cursor and chain-event deduplication.

For each area: define/verify the entity, add a forward migration, convert service and module wiring, update tests/fixtures, then run targeted PostgreSQL integration tests. Avoid dual writes. Where existing data exists, provide an explicit, restartable migration/backfill plan before cutover.

### Phase 2 — Remove Prisma

Only when Phase 1 is complete:

- Remove all imports of `PrismaService`, `PrismaModule`, generated Prisma types, and Prisma test helpers.
- Remove Prisma generation and migration scripts from package scripts and Docker build stages.
- Remove Prisma dependencies and generated artifacts; regenerate and verify the lockfile with the supported Node/npm toolchain.
- Delete `prisma/schema.prisma` and Prisma migration history only after confirming that no deployed environment depends on them and that required data has a verified TypeORM migration path.
- Run a repository-wide search proving there are no remaining active Prisma references.

### Phase 3 — Release baseline

On the exact candidate commit, require:

- `npm ci`
- generated-artifact/config drift checks
- TypeScript typecheck and production build
- lint and unit tests
- PostgreSQL integration tests
- clean-database migration apply, schema-drift check, rollback/reapply
- Docker build and container smoke test
- security scans
- independent review of the persistence and migration changes

No merge or release-readiness claim is made until all required gates pass.

## Explicitly deferred

- No feature expansion while persistence contracts are being reconciled.
- No destructive migration, production reset, automatic schema synchronization, or unverified backfill.
- No removal of Prisma packages before the last consumer is converted.
- No parallel Prisma and TypeORM writes during the transition.
