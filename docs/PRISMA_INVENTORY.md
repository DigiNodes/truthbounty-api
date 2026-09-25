# Prisma Inventory

Search report for every Prisma reference in this repository, produced for STAB-BE-003
(issue #517, "Remove Prisma Remnants and Prove the TypeORM-Only Baseline").

## Summary

Prisma is **not** inert in this repository. It is a live, load-bearing second persistence
layer used by 7 feature modules. A full removal would break the application, so this
document records what remains, why it remains, and what must happen before it can be removed.

| Claim | Status |
| --- | --- |
| Prisma is fully removable today | **No.** Blocked; see "Blocker" below. |
| CI exercised dead Prisma code instead of the real schema | **Yes, and now fixed.** See "CI change". |
| Application schema is TypeORM | **Yes.** 17 TypeORM migrations in `src/migrations/`. |
| A repository search report exists | This document. |

## Method and limits

The inventory below was produced by reading the repository: a case-insensitive search for
`prisma` across every tracked file, followed by reading each hit to classify it. Findings were
not confirmed by running the code, building the image, or executing the test suite, so every
"retained" classification is a statement about the source as written, not about observed
runtime behaviour.

Excluded from the search: `package-lock.json` (a generated resolution graph, summarised in
"Declared packages" below) and `src/generated/client/**` (a generated client tree, summarised
separately). Both are described rather than enumerated line by line.

## Blocker: what stops full removal

`src/prisma/prisma.service.ts` is imported by **11 production service files across 7
feature modules**, plus 7 module-wiring files and `src/app.module.ts`. Counted
mechanically with
`grep -rlE "from '.*prisma/prisma\.(service|module)'|@prisma/client" src --include='*.ts'`,
excluding the 20 generated files under `src/generated/client/**` and the 6 `.spec.ts`
files listed separately below.

| Module | File | What it reads or writes through Prisma |
| --- | --- | --- |
| Identity | `src/identity/identity.service.ts` | `User`, `Wallet`, `$transaction`; also imports `Prisma`, `User`, `Wallet` types straight from `@prisma/client` |
| Identity | `src/identity/worldcoin/worldcoin.service.ts` | `worldIdVerification`, `user` (dual-writes alongside TypeORM) |
| Auth | `src/auth/auth.service.ts` | `wallet` |
| Analytics | `src/analytics/analytics.service.ts` | `user`, `conversation`, `message` |
| Outbox | `src/outbox/outbox.service.ts` | `outboxEvent` |
| Notifications | `src/notifications/services/notifications.service.ts` | `outboxEvent` |
| Sybil resistance | `src/sybil-resistance/sybil-resistance.service.ts` | `user`, `sybilScore` |
| AI assistant | `src/ai-assistant/services/ai-assistant.service.ts` | `conversation`, `message`, `aiUsageMetric` |
| AI assistant | `src/ai-assistant/services/rag.service.ts` | `contextDocument` |
| AI assistant | `src/ai-assistant/ai-assistant.service.ts` | duplicate of the file above; also imports `PrismaService` (see stale references) |
| AI assistant | `src/ai-assistant/rag.service.ts` | duplicate of the `services/` file above; also imports `PrismaService` (see stale references) |
| App wiring | `src/app.module.ts` | imports `PrismaModule` globally |
| Module wiring | `analytics`, `auth`, `identity`, `notifications`, `outbox`, `sybil-resistance`, `ai-assistant` `.module.ts` | each imports `PrismaModule` |

Six `.spec.ts` files also import `PrismaService` and must move with it:
`src/identity/identity.service.spec.ts`, `src/identity/worldcoin/worldcoin.service.spec.ts`,
`src/outbox/outbox.service.spec.ts`, `src/sybil-resistance/sybil-resistance.service.spec.ts`,
`src/ai-assistant/ai-assistant.service.spec.ts`, and `src/ai-assistant/services/rag.service.spec.ts`.

`src/notifications/notifications.service.ts` (the top-level file, not the
`services/` one) does **not** import Prisma; only
`src/notifications/services/notifications.service.ts` does.

`PrismaModule` is `@Global()`, so `PrismaService` constructs and opens a database connection
during application bootstrap. Removing the Prisma packages without removing these call sites
breaks module resolution at startup, not just at query time.

The acceptance criterion for #517 ("production and test dependency graphs contain no Prisma
runtime/tooling packages") is therefore **not met by this change**, and is recorded as such
rather than claimed.

## Conflict with issue #392

Open issue **#392, "V2-BE-041 - Complete Prisma-Only Persistence Convergence"**, mandates the
opposite end state: it asks for convergence *onto* Prisma, and would keep or expand
`prisma/schema.prisma` and `prisma/migrations/` as the canonical schema.

This issue (#517) asks for convergence onto TypeORM. Both cannot be true. They are not
reconciled here.

Recommended reconciliation, for the maintainer to choose:

1. **Land this change, then close #392 as superseded.** The evidence favours TypeORM: the
   protocol schema (17 migrations, the entities, the indexer projections, the CI gate added
   here) is TypeORM, and Prisma is the layer that carries identity, analytics, outbox and AI
   data. #392 appears to predate that migration of the protocol schema.
2. **Alternatively, land the Prisma migration gate instead** and revert the CI change. That is
   a larger, riskier piece of work and is not attempted here.

Until that is decided, treat the direction as **unresolved** and do not delete either tree.

## CI change (the part that was actually broken)

`.github/workflows/ci.yml` previously ran, as its "Run migration tests" step:

```bash
npx prisma migrate reset --force
npx prisma migrate deploy
```

This exercised the legacy Prisma migration set. The TypeORM migrations in `src/migrations/`,
which are the ones the application actually runs, were never applied, rolled back, or
compared against the entities in CI. The gate was green while the real schema path was
untested.

That step is replaced by a dedicated `schema-migration-gate` job that, against an empty
PostgreSQL service database, using `src/config/data-source.ts`:

1. `npm run migration:run` - applies all 17 committed TypeORM migrations in order.
2. Runs `typeorm-ts-node-commonjs migration:generate` and inspects the result:
   - exit `0` means TypeORM wrote a migration, i.e. the entities and the committed
     migrations disagree, i.e. **schema drift**. The job prints the generated migration and
     fails.
   - a non-zero exit that does **not** report "No changes in database schema were found" is
     treated as an unresolved failure, not a pass. This distinction is deliberate: a
     generator crash must never be mistaken for a clean schema.
3. `npm run migration:revert` followed by `npm run migration:run` - proves the most recent
     migration is reversible and re-appliable.

### Known blocker in this gate

`src/config/data-source.ts` line 3 imports `SnakeNamingStrategy` from
`typeorm-naming-strategies`, but that package is **not declared in `package.json` and is not
present in `package-lock.json`**. The import cannot be resolved.

Consequence: `npm run migration:run` cannot currently load the data source, and the new gate
will fail at that step with a module-resolution error. This is a pre-existing defect in the
TypeORM migration path, not something this change introduces - the previous Prisma-based
step never touched the file, which is why it went unnoticed.

It was not fixed here because fixing it requires either an install (adding the dependency
regenerates `package-lock.json`, and a lockfile that cannot be regenerated and verified is
exactly the unverifiable change STAB-BE-004 warns against) or a behavioural change to column
naming (dropping the snake_case strategy would change the generated column names that the 17
committed migrations were written against).

**One-line fix for the maintainer** (run locally with the supported toolchain, then review
the lockfile diff):

```bash
npm install --save typeorm-naming-strategies@^4
```

The gate is expected to be red until that lands. That is the gate doing its job: it is
reporting a real defect rather than reporting a green check on untested code.

## Declared packages

| Package | Declared as | Resolved in `package-lock.json` | Kept because |
| --- | --- | --- | --- |
| `@prisma/client` | `dependencies`, `^7.3.0` | `7.4.1` | Runtime import in `src/identity/identity.service.ts`; runtime library import (`@prisma/client/runtime/client`) throughout `src/generated/client/` |
| `@prisma/adapter-libsql` | `dependencies`, `^7.3.0` | `7.4.1` | Runtime import in `src/prisma/prisma.service.ts` (`PrismaLibSql`) |
| `prisma` | `devDependencies`, `^7.10.0` | `7.10.0` | CLI. Used by `npx prisma generate` in the `Dockerfile` and by `test/utils/prisma-test-db.helper.ts` (`prisma db push`) |

The `Dockerfile` still runs `npx prisma generate` in the builder stage. Whether that step
should remain is tracked by the parallel work in this same pull request (STAB-BE-003) and by
open issue **#392**. It is retained here for consistency with those two threads: removing it
would also require deciding the fate of `src/generated/client/`, which the runtime still
imports. It is called out in the commit message so the decision is not lost.

The container smoke workflow asserts that `prisma` is **absent** from the shipped production
image, which is the truthful current state: `npm prune --production` removes it.

## Retained references, with reasons

### Runtime code (load-bearing)

| Path | Reference | Why retained |
| --- | --- | --- |
| `src/prisma/prisma.service.ts` | `PrismaService` extends `PrismaClient` from `src/generated/client/client`, backed by `@prisma/adapter-libsql` | Injected into 7 feature modules (11 service files). Removing it is the #392/#517 reconciliation, not a cleanup. |
| `src/prisma/prisma.module.ts` | `@Global()` `PrismaModule` | Same. Registered in `src/app.module.ts`. |
| `src/app.module.ts` | imports and registers `PrismaModule` | Bootstrap wiring for the above. |
| `src/identity/identity.service.ts` | `import { Prisma, User, Wallet } from '@prisma/client'` | The **only** direct `@prisma/client` type import in application code. Blocks removing `@prisma/client`. |
| `src/identity/worldcoin/worldcoin.service.ts` | `PrismaService` | Dual-writes verification records to both ORMs; removing the Prisma half is a data-model decision. |
| `src/auth/auth.service.ts` | `PrismaService` | Wallet lookup for authentication. |
| `src/analytics/analytics.service.ts` | `PrismaService` | Contributor, conversation and message aggregates. |
| `src/outbox/outbox.service.ts` | `PrismaService` | Outbox event persistence. |
| `src/notifications/services/notifications.service.ts` | `PrismaService` | Outbox delivery. |
| `src/sybil-resistance/sybil-resistance.service.ts` | `PrismaService` | Sybil score persistence. |
| `src/ai-assistant/services/ai-assistant.service.ts` | `PrismaService` | Conversation, message and usage-metric persistence. |
| `src/ai-assistant/services/rag.service.ts` | `PrismaService` | RAG context-document retrieval. |
| `src/generated/client/**` | Generated Prisma client, committed to the repository | Imported at runtime by `src/prisma/prisma.service.ts` and copied into the image by the `Dockerfile` runner stage. Regenerated by `npx prisma generate`. |

### Tests (load-bearing, or at minimum not removable without running the suite)

| Path | Reference | Why retained |
| --- | --- | --- |
| `test/utils/prisma-test-db.helper.ts` | `execSync('npx prisma db push ...')` | Provisions the isolated SQLite database four AI-assistant e2e specs run against. `prisma db push`, not `migrate`, is what makes the throwaway DB match the schema; see `docs/AI_ASSISTANT_OPERATIONS.md` for why. |
| `test/ai-assistant*.e2e-spec.ts` (4 files) | `setupPrismaTestDatabase` | Call the helper above. |
| `test/utils/ai-assistant-auth.helper.ts` | `PrismaService` | Creates `User` + `Wallet` rows with the RBAC `role` column for e2e auth. |
| `test/utils/ai-assistant-test.module.ts` | `PrismaModule` | Trimmed test module wiring. |
| `test/utils/test-helpers.ts` | `PrismaService`, `PrismaModule` | See "Stale" below. |
| `test/fixtures/contracts/fixtures.example.spec.ts` | `PrismaService`, `PrismaModule` | See "Stale" below. |
| `test/outbox-idempotent-delivery.integration.spec.ts` | `jest.mock('../src/prisma/prisma.service')` | Mocks the service precisely to avoid loading the native `@libsql` driver adapter. The mock is the point. |
| `src/auth/auth.service.spec.ts`, `src/auth/guards/roles.guard.spec.ts`, `src/identity/identity.service.spec.ts`, `src/identity/worldcoin/worldcoin.service.spec.ts`, `src/outbox/outbox.service.spec.ts`, `src/sybil-resistance/sybil-resistance.service.spec.ts`, `src/ai-assistant/ai-assistant.service.spec.ts`, `src/ai-assistant/services/rag.service.spec.ts`, `src/jobs/jobs.service.spec.ts` | `PrismaService` test doubles | Injecting the service into the modules under test. `src/jobs/jobs.service.spec.ts` mocks the module outright. |
| `src/dockerfile.spec.ts` | asserts `prisma/schema.prisma` contains `binaryTargets = ["native", "linux-musl"]` | **This test is what pins `prisma/schema.prisma` in place.** Deleting the schema breaks an active unit test. |
| `src/entities/user.entity.spec.ts` | "TypeORM <-> Prisma sync" field-coverage assertions | Active test that compares the two `User` definitions. It is a migration aid, and it is evidence the two layers are intended to converge. |

### Generated client, environment, and toolchain configuration

| Path | Reference | Why retained |
| --- | --- | --- |
| `prisma/schema.prisma` | Source of truth for the Prisma client | Generates `src/generated/client/`. Pinned by `src/dockerfile.spec.ts`. |
| `prisma/migrations/**` (4 migrations) | `20260122115647_init`, `20260129_add_sybil_scores`, `20260728000000_add_user_role`, `20260924000000_add_outbox_event`, plus `migration_lock.toml` | **Migration history for data that exists.** `prisma db push` in the e2e helper bypasses it, but the rows created by `prisma migrate`-era deployments are only described here. Not deletable without a data-retention decision. |
| `prisma.config.ts` | `defineConfig` with `schema: "prisma/schema.prisma"` and `migrations.path: "prisma/migrations"` | Required by the `prisma` CLI v7. Removing it breaks `npx prisma generate` in the `Dockerfile`. |
| `Dockerfile` line 14-16 | `npx prisma generate` | See "Declared packages". |
| `.env.example` lines 116-120 | `# Prisma Configuration (SQLite/LibSQL)` / `DATABASE_URL=file:./dev.db` | Required by `PrismaService`, which defaults to `file:./dev.db`. **See the hazard below.** |
| `.env.docker` line 4 | `# PostgreSQL (Prisma)` comment above `DATABASE_URL=postgresql://...` | Comment only. Both the value and the comment are wrong for Prisma; see the hazard below. |
| `.gitignore` line 67 (`/generated/prisma`) | **Removed** | The generator output is pinned to `../src/generated/client` by `prisma/schema.prisma`, so a repo-root `generated/prisma` directory can no longer be produced. The entry was dead. |

### Environment variable hazard (found, not fixed)

`DATABASE_URL` is overloaded between the two layers, with incompatible meanings:

- `src/config/data-source.ts`: any value in `DATABASE_URL` selects **PostgreSQL** (`type: 'postgres', url: DATABASE_URL`).
- `src/prisma/prisma.service.ts`: `DATABASE_URL` is passed to `PrismaLibSql`, which only accepts a **libsql/SQLite** URL.

`.env.example` sets `DATABASE_URL=file:./dev.db`, which satisfies Prisma and breaks TypeORM.
`.env.docker` sets `DATABASE_URL=postgresql://postgres:postgres@postgres:5432/truthbounty`,
which satisfies TypeORM and breaks Prisma. Neither file is correct for both layers.

This is not fixable in a doc edit, and renaming the variable would touch 7 feature
modules. It
is recorded here as the concrete technical work that #392's reconciliation requires: the two
layers need distinct connection configuration before either can be removed.

## Stale references (recorded, not changed)

These are inaccurate or dead. Each is a documentation or dead-code change with no runtime
effect, but each is listed rather than silently fixed so the reviewer can decide.

| Path | Line(s) | Problem | Why not changed here |
| --- | --- | --- | --- |
| `src/ai-assistant/ai-assistant.service.ts` | whole file | Duplicate of `src/ai-assistant/services/ai-assistant.service.ts`. The module wires the `services/` version; this one is only imported by `src/ai-assistant/ai-assistant.service.spec.ts`. | Deleting it requires deleting or repointing an active spec. Not verifiable without running tests. |
| `src/ai-assistant/rag.service.ts` | whole file | Duplicate of `src/ai-assistant/services/rag.service.ts`, same situation. | Same. |
| `test/utils/test-helpers.ts` | `clearDatabase`, `seedTestData` | Uses `TRUNCATE ... RESTART IDENTITY CASCADE` (PostgreSQL-only) against a SQLite/libsql database, and seeds `prisma.stake`, `prisma.reward` and `prisma.dispute`, **none of which exist** in `prisma/schema.prisma`. Imported only by `test/fixtures/contracts/fixtures.example.spec.ts`. | Appears to be dead scaffolding whose consumer is itself an example fixture. Confirming it is dead requires running the suite. |
| `test/fixtures/contracts/fixtures.example.spec.ts` | whole file | Depends on the above, so it inherits the same problems. Named `.example.spec.ts` but matches the `*.spec.ts` test regex in `jest.config.js`, so it is collected. | Same. |
| `docs/API_REFERENCE.md` | 493 | "The API is built with NestJS and uses Prisma for database operations." Inaccurate for the protocol schema. | Documentation drift; worth a follow-up with the rest of the doc corrections. |
| `ARCHITECTURE.md` | 341 | Sequence diagram labels a step "Domain Action (Prisma Transaction)". | Inside an ASCII diagram; editing it risks corrupting the layout. |
| `docs/BACKEND_DOCUMENTATION.md` | 26 | ASCII diagram ends a line with "Prisma)". | Inside an ASCII diagram, same reason. |
| `src/COMPONENTS.md` | 779-890 | Documents a `PrismaService` with `prisma.claim` examples; those models do not exist. | Large stale document; a targeted rewrite is its own change. |
| `src/COMPONENTS_QUICK_REFERENCE.md` | 26, 128, 218, 450 | Same class of staleness, and links to `prisma/schema.prisma` as "Database Schema". | Same. |
| `scripts/generate-outbox-migration.js` | whole file | One-off helper that diffs Prisma schemas. Not referenced by any `package.json` script or workflow. | Historical record of how the outbox migration was produced; deleting it removes provenance for `prisma/migrations/20260924000000_add_outbox_event`. |
| `PULL_REQUEST.md` | 33 | Historical PR description mentioning a Prisma-aware `database-profiler.ts`. | Historical artefact, not living documentation. |
| `.github/pull_request_template.md` | 20 | Checkbox asserts "TypeORM/PostgreSQL remains the only persistence architecture". True as a policy for *new* pull requests, not as a description of the tree. | The enforcement for it already exists as a `::warning::` in `v2-policy-advisory.yml`. Rewording it risks weakening the policy while the tree still contains Prisma. |
| `docs/runbooks/outbox-notification-delivery.md` | 5 | "Persistence: Prisma `OutboxEvent` table" | **Accurate** - `src/outbox/outbox.service.ts` really does persist there. Also outside this change's scope. |
| `docs/AI_ASSISTANT_ARCHITECTURE.md`, `docs/AI_ASSISTANT_SECURITY.md`, `docs/AI_ASSISTANT_OPERATIONS.md` | various | Describe the Prisma-backed AI data. | Accurate and deliberately detailed; already state the TypeORM/Prisma split. Keep. |
| `.github/workflows/v2-policy-advisory.yml` | 24, 28 | Uses `|| true` and `exit 0`. | Not masking: the workflow is explicitly advisory, is named "(advisory)", and ends with "Advisory mode: findings do not fail this workflow." A `::warning::` is the intended output. Listed here so the pattern is accounted for rather than overlooked. |

## Follow-up, in dependency order

1. Add `typeorm-naming-strategies` to `package.json` and commit the regenerated lockfile.
   Unblocks the migration gate. (Blocking, one command.)
2. Resolve #392 vs #517 and record the decision. Everything below depends on it.
3. Give the two persistence layers distinct connection configuration so `DATABASE_URL` is not
   overloaded.
4. If TypeORM wins: port `User`/`Wallet` to TypeORM, then work down the module list in
   "Blocker" above, deleting each Prisma call site and its test double as you go. Delete
   `src/prisma/`, `src/generated/client/`, `prisma/`, `prisma.config.ts`, and the three
   Prisma packages last, after `src/dockerfile.spec.ts` is updated.
5. If Prisma wins: revert the `schema-migration-gate` job in `ci.yml` and add an equivalent
   Prisma-based gate, including a real `prisma migrate` run against an empty database.
6. Either way, delete `prisma/migrations/` last and only with a data-retention decision.
