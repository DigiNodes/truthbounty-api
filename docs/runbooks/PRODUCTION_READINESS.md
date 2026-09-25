# Operations Runbook: V2 API Production Readiness Certification

> **This document is a template, not a readiness claim.** Nothing in this
> repository has been certified. Every row in the check table
> ([§4](#4-the-check-table)) is `UNVERIFIED` by default, and this file is
> worthless until an independent maintainer executes it against a real
> environment and fills in the evidence, the date, and their signature in
> [§6](#6-sign-off). If you are reading this expecting a statement that the V2
> API is production-ready, the statement is: **it has not been assessed.**

> **Authority boundary (a certification criterion, not a disclaimer).** Smart
> contracts and finalized canonical events remain strictly authoritative. The
> certification in this document asserts that the API indexes, validates,
> relays and serves them correctly and **fails closed when it cannot** — never
> that the API is authoritative for settlement, rewards, treasury, governance,
> claims, or disputes. See [§4.5.10](#4510-the-api-is-never-authoritative--blocking-criterion),
> which cannot be waived, deferred, or marked `N/A`.

---

## 1. What this is for

Issue #504 (V2-BE-150) asks to certify the V2 API for production. A
certification is only meaningful if it is:

- **Independent** — signed by someone who did not produce the thing being
  certified.
- **Evidence-backed** — every check cites an artifact, a run, or a URL. "Looks
  fine" is not evidence.
- **Falsifiable** — it states what would make the answer "no".
- **Honest about the unknown** — an unrun check is `UNVERIFIED`, not a pass.

This document provides the checklist and the record format. It does not provide
the results.

**Companion documents.** Execute this gate alongside:

| Document | What it gives you |
| -------- | ----------------- |
| [../NESTJS_BASELINE.md](../NESTJS_BASELINE.md) | The dependency baseline and its guard (§4.1). |
| [../indexer-runbook.md](../indexer-runbook.md) | Indexer signals and thresholds (§4.3). |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Severity, roles, fail-closed vs fail-open (§4.5). |
| [ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md) | The rollback plan to verify (§4.10). |
| [outbox-notification-delivery.md](outbox-notification-delivery.md) | Outbox/notification delivery (§4.8, partial). |
| [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) | RTO/RPO, rebuild, snapshot restore (§4.3, §4.10). |
| [../DEPLOYMENT.md](../DEPLOYMENT.md) | Deployment ordering (§4.2, §4.7). |
| [../OPERATIONS_MANUAL.md](../OPERATIONS_MANUAL.md), [../MONITORING_GUIDE.md](../MONITORING_GUIDE.md) | Profiling workflow, latency budgets, the monitoring surface (§4.8). |

---

## 2. Prerequisite: canonical contract artifacts

Issue #504 depends on V2-BE-149, and states that referenced contract ABI and
address artifacts must already be canonical. **That is a hard prerequisite, not
a check.** Do not begin the gate below until it is satisfied.

The enforcement point in the code is `ContractArtifact`
(`src/v2/events/entities/contract-artifact.entity.ts`) and
`ArtifactRegistryService` (`src/v2/events/artifact-registry.service.ts`):

- An allow-list of `(chainId, contractAddress)` pairs, each pinned to one
  `artifactVersion` and one approved ABI, unique on
  `(chainId, contractAddress)`.
- `isApproved` is the fail-closed gate, and the entity's own doc comment states
  the invariant: *"An address with no row, or a row where this is false, is
  never decoded; its logs are quarantined as unregistered."*
- `ArtifactRegistryService.resolve` returns `null` for an unregistered or
  unapproved address rather than falling back to a default or legacy ABI.
- The source comment records that this entity is a deliberate stand-in for the
  V2-BE-008 canonical-artifact interface, which had not merged, and that it is
  expected to be replaced or reconciled once that lands.

Before the gate:

```sql
-- Every address the API will decode must be here, and approved.
SELECT "chainId", "contractAddress", "artifactVersion", "isApproved", "registeredAt"
FROM v2_contract_artifacts
ORDER BY "chainId", "contractAddress";

-- Anything configured but not registered shows up here as a fail-closed stop.
SELECT COUNT(*) AS quarantined_unregistered FROM v2_event_quarantine
WHERE reason = 'unregistered_address';
```

**Gate entry condition:** for every address in the deployment's
`INDEXED_CONTRACTS` configuration, there is a row in `v2_contract_artifacts` with
`isApproved = true`, and its `artifactVersion` matches the canonical release
named in V2-BE-149. Record the artifact version set here:

```
Artifact versions certified: <chainId:address@version, ...>
Canonical source            : <where the V2-BE-149 artifacts live>
```

If V2-BE-149's artifacts are not yet canonical in this environment, the
certification **cannot be granted**, and this is recorded as the blocking reason
in the [§5](#5-no-go-record) no-go record.

---

## 3. How to run the gate

1. **Environment.** A production-shaped environment: real PostgreSQL (not the
   SQLite fallback that `src/config/data-source.ts` selects when `DATABASE_URL`
   is unset), real Redis, a real Optimism RPC endpoint, real SMTP, the same
   image, and the same environment variables as production. Record what it is
   and how it differs.
2. **Independence.** The signer in [§6](#6-sign-off) did not author the change
   being certified. If you did, the certification is void — say so and find
   another signer.
3. **Order matters.** Run the checks in the order below. Each group assumes the
   previous ones passed. A failure in an early group invalidates the evidence
   for everything after it.
4. **Record as you go.** Evidence links, not recollections. Paste the command
   and its output; do not summarise it.
5. **One row at a time.** Do not batch. A partially filled row is worse than an
   empty one, because it looks like coverage.
6. **Stop on the first blocking failure.** Record it, mark the certification
   **NO-GO**, and go to [§5](#5-no-go-record). Do not continue and "partially
   certify".

---

## 4. The check table

**Status vocabulary — use exactly these, nothing else:**

| Status | Meaning |
| ------ | ------- |
| `UNVERIFIED` | Not run, or run without interpretable output. **This is the default for every row.** |
| `PASS` | Executed, evidence captured and linked, result matches the pass criterion. |
| `FAIL` | Executed, result does not match the pass criterion. |
| `BLOCKED` | Cannot be executed because a prerequisite is unmet. Name the prerequisite. |
| `N/A` | Genuinely not applicable, with a one-line justification. Requires the signer's agreement, not the operator's. |

**Evidence** means a commit SHA, a CI run URL, a command plus its output, a
screenshot, or a query plus its result. A row cannot be `PASS` with an empty
evidence cell.

### 4.1 Dependency baseline

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 1.1 | `node scripts/check-nest-baseline.mjs` exits `0` | Baseline consistent; runtime and `@nestjs/testing` majors aligned | `UNVERIFIED` | | | |
| 1.2 | `npm ci` on a **fresh checkout** with the supported Node/npm, no `--force`, no `--legacy-peer-deps` | Completes with no ERESOLVE and no peer warnings | `UNVERIFIED` | | | |
| 1.3 | `npm ci` warnings reviewed | No unresolved peer or engine warnings; any accepted warning is written down | `UNVERIFIED` | | | |
| 1.4 | `npx eslint "{src,apps,libs,test}/**/*.ts"` (read-only) | Clean | `UNVERIFIED` | | | |
| 1.5 | `npm run build` produces a clean tree | `git status --porcelain` is empty after the build (the drift check CI performs) | `UNVERIFIED` | | | |
| 1.6 | `npm run test:cov` and `npm run test:e2e` | Pass; the coverage summary is pasted, not summarised | `UNVERIFIED` | | | |

**Notes for 1.2 and 1.3.** The repository declares `engines.node ">=20 <21"` and
CI uses `node-version: '20'`, while `@nestjs/schematics@12.0.2` records
`engines.node "^22.22.3 || ^24.15.0 || >=26.0.0"` in `package-lock.json`. These
ranges do not overlap. No `.npmrc` exists in the repository, so `engine-strict`
is not enabled in-repo and this is expected to surface as a warning rather than a
failure — **but that expectation is unconfirmed.** Record the actual install
output, including any `EBADENGINE` line:

```
Install warnings observed: <paste, or "none">
```

`@nestjs/schematics@12.0.2` also declares peer `typescript >=6.0.0` while the
lockfile resolves `typescript` to `5.9.3`. Dev-tooling only; record it, do not
paper over it.

### 4.2 Migrations, from a clean database

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 2.1 | **Prisma** migrations from clean: `npx prisma migrate reset --force` then `npx prisma migrate deploy` | Succeeds | `UNVERIFIED` | | | |
| 2.2 | **TypeORM** migrations from a clean PostgreSQL: `npm run migration:run` | All 17 migrations in `src/migrations/` apply in order, no errors | `UNVERIFIED` | | | |
| 2.3 | TypeORM rollback: `npm run migration:revert` × 17, then `npm run migration:run` again | Returns to the clean state with no error and no residue | `UNVERIFIED` | | | |
| 2.4 | Schema after 2.2 matches the entity set | `synchronize: false` on the PostgreSQL path; no drift between entities and schema | `UNVERIFIED` | | | |
| 2.5 | `GET /health` → `diagnostics.database.migrationsPending` | `0` | `UNVERIFIED` | | | |
| 2.6 | Production start path applies migrations before serving | Ordering per [../DEPLOYMENT.md](../DEPLOYMENT.md) §2 | `UNVERIFIED` | | | |
| 2.7 | `DATABASE_SYNCHRONIZE` is not `true` anywhere in production config | Confirmed false; the PostgreSQL path in `src/config/data-source.ts` hard-codes `synchronize: false` | `UNVERIFIED` | | | |

> **Why 2.2 and 2.3 are listed separately from 2.1.** The CI job named "Run
> migration tests" runs `npx prisma migrate reset --force` and
> `npx prisma migrate deploy`. That exercises `prisma/migrations/` (four
> migrations). It does **not** touch the TypeORM migrations in
> `src/migrations/` (seventeen), which are the schema path for the
> TypeORM/PostgreSQL data source. A green CI run is therefore **not** evidence
> for 2.2 or 2.3, and a green 2.1 must not be read as covering them.

> **Known risk, flagged by reading the migration sources — not executed here.**
> `src/migrations/1769800400000-AddVerificationDisputeEnhancements.ts` alters
> and drops columns on `v2_project_verification_rounds`,
> `v2_project_participant_positions` and `v2_project_disputes` (plural), while
> the entities and the creating migrations use the singular names
> `v2_project_verification_round` and `v2_project_participant_position`
> (`src/migrations/1769800200000-CreateV2VerificationTables.ts`,
> `src/v2/verification/entities/*.entity.ts`) and `v2_project_dispute`
> (`src/migrations/1769800300000-CreateV2DisputesTables.ts`,
> `src/v2/disputes/entities/project-dispute.entity.ts`). If those plural
> relations do not exist in a clean database, both the `up()` and the `down()` of
> that migration fail on a missing relation. **Check 2.2 is where this surfaces,
> or it does not surface at all.** Record the outcome:

```
Check 2.2 result: <pass | error, with the full first error pasted>
```

### 4.3 Indexer reprocessing

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 3.1 | `GET /health/indexer` reports `healthy` after convergence | `projectionLag` inside the snapshot's own `alertThresholds.projectionLagBlocks` | `UNVERIFIED` | | | |
| 3.2 | Cursors are populated and monotonic | `v2_event_checkpoints.lastSafeBlock` non-zero and only ever increasing; `observedHeadBlock` / `safeBlock` / `finalizedBlock` non-zero | `UNVERIFIED` | | | |
| 3.3 | Projector cursors advance | `v2_projector_cursors` rows for evidence, verification and disputes all advance | `UNVERIFIED` | | | |
| 3.4 | **Idempotent reprocess**: replay a range, then re-query | `v2_canonical_events` row count for that range is unchanged; `indexer_replay_count_total` increments | `UNVERIFIED` | | | |
| 3.5 | Replay via `POST /indexer/backfill` for a known range | Range is re-read; no duplicate rows; the checkpoint does not regress | `UNVERIFIED` | | | |
| 3.6 | Restart resumes from the persisted checkpoint | `POST /indexer/restart` (or a process restart) resumes at the stored cursor, not from genesis | `UNVERIFIED` | | | |
| 3.7 | Rebuild from a checkpoint is deterministic | Two rebuilds of the same range produce identical projected state | `UNVERIFIED` | | | |
| 3.8 | Quarantine is not accumulating unexplained | `v2_event_quarantine` counts per `reason` are stable, and each non-empty reason is explained | `UNVERIFIED` | | | |
| 3.9 | Full rebuild from chain data is viable | The rebuild path in [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §3 works and converges | `UNVERIFIED` | | | |

Replay safety is asserted in code, not just in docs: `v2_canonical_events` is
unique on `(chainId, txHash, logIndex)` and `CanonicalEventsService.ingest`
catches the Postgres `23505` unique violation and returns
`{ status: 'duplicate' }`; `v2_event_quarantine` is unique on
`(chainId, txHash, logIndex)` and swallows the same violation; projector writes
are guarded by unique constraints on `(eventTxHash, eventLogIndex)`;
`ReorgSafeCursorService` commits cursor and projections in a single transaction.
**Checks 3.4–3.7 exist to confirm that behaviour in this environment, not to
discover it.**

### 4.4 Reorg, duplicate delivery, and stale data

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 4.1 | Reorg at the safe boundary is handled | Events below the safe cursor are not marked finalized; affected rows are re-evaluated | `UNVERIFIED` | | | |
| 4.2 | `DataState` is respected end to end | `observed` / `safe` / `finalized` (`src/v2/common/data-state.enum.ts`) are never conflated; no `observed` row is reported as settled | `UNVERIFIED` | | | |
| 4.3 | Duplicate canonical delivery is suppressed | `v2_canonical_events` shows exactly one row per `(chainId, txHash, logIndex)` after a deliberate double-ingest | `UNVERIFIED` | | | |
| 4.4 | Duplicate notification delivery is suppressed | The Redis `SETNX` guard and, when Redis is unavailable, the `DeliveryHistory` DB guard both suppress; no duplicate reaches a user | `UNVERIFIED` | | | |
| 4.5 | Stale reads are not served as fresh | Cached claim reads respect `CACHE_CLAIMS_TTL` (default 300s) and `CACHE_VERSION`; a stale cache entry is not returned as current without qualification | `UNVERIFIED` | | | |
| 4.6 | A reorg-affected projection is corrected, not defended | After a simulated reorg, projected state converges back to the canonical events | `UNVERIFIED` | | | |
| 4.7 | Dead letters are recoverable | Events past max retries are reprocessable by replay, and `indexer_dead_letters_total` stops climbing | `UNVERIFIED` | | | |
| 4.8 | Deep reorg response is the documented one | Follows [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §4 | `UNVERIFIED` | | | |

### 4.5 Fail-closed behaviour

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 5.1 | Database down → readiness fails | `/health/ready` → `503`; `database` is `unhealthy`; reads are **not** served from cache to "stay up" | `UNVERIFIED` | | | |
| 5.2 | Queue unreachable → readiness fails | `/health/ready` → `503`; `queue` is `unhealthy` | `UNVERIFIED` | | | |
| 5.3 | Blockchain state missing → readiness fails | `/health/ready` → `503`; `blockchain` is `unhealthy` | `UNVERIFIED` | | | |
| 5.4 | Indexer `unhealthy` (missing cursors) → readiness fails | `checkBlockchain` throws when `getIndexerHealth().status === 'unhealthy'` | `UNVERIFIED` | | | |
| 5.5 | Redis down → `degraded`, still ready | `/health/ready` stays `200`; `redis` is `degraded`; reads fall through to the database | `UNVERIFIED` | | | |
| 5.6 | Notification backlog → `degraded`, still ready | Depth above the `checkNotifications` threshold yields `degraded`, not `unhealthy` | `UNVERIFIED` | | | |
| 5.7 | IPFS down → `degraded`, still ready | `ipfs` is `degraded`; nothing deciding protocol state depends on it | `UNVERIFIED` | | | |
| 5.8 | Unregistered contract is never decoded | `ArtifactRegistryService.resolve` → `null`; the log is quarantined as `unregistered_address`; no default/legacy ABI fallback occurs | `UNVERIFIED` | | | |
| 5.9 | Undecodable logs are quarantined, not dropped or force-decoded | A malformed log lands in `v2_event_quarantine` with a reason and the raw log | `UNVERIFIED` | | | |
| **5.10** | **The API is never authoritative — BLOCKING** | See [§4.5.10](#4510-the-api-is-never-authoritative--blocking-criterion) below | `UNVERIFIED` | | | |

The critical/non-critical split in 5.1–5.7 is the `critical: true|false` flag on
each check in `HealthService.runChecks` (`src/health/health.service.ts`) and is
implemented, not aspirational. **The certification requirement is that it was
observed to behave that way under real dependency failure**, which is why each
of these is a separate row with its own evidence.

Two documented fail-open points are intentional and must be confirmed as
intentional rather than "fixed":

- `RedisService.setnx` returns `true` when Redis is unavailable, so the fast
  idempotency guard is skipped and the authoritative
  `DeliveryHistory.findByIdempotencyKey` guard decides. Changing this to `false`
  would suppress legitimate first deliveries.
- `createThrottlerStorage` in `src/app.module.ts` falls back to in-memory
  throttler storage when Redis is unreachable, which makes rate limits
  **per-instance and weaker**. That is an availability/security trade; the
  signer must accept it explicitly.

#### 4.5.10 The API is never authoritative — blocking criterion

This is the one check that cannot be waived, deferred, or marked `N/A`. All of
the following must be true:

- [ ] No code path mutates settlement, reward, treasury, governance, claim, or
      dispute outcome. The API indexes, validates, relays and serves; contracts
      and finalized canonical events decide.
- [ ] No read endpoint synthesizes protocol state. Where the indexer's view is
      missing or uncertain, the response is a `503` or an explicitly-qualified
      result, never a plausible-looking value.
- [ ] No operator procedure in any runbook writes a projection, canonical event,
      checkpoint or cursor by hand to make state look correct. Recovery is
      replay-from-chain, per
      [ROLLBACK_AND_RECOVERY.md §5](ROLLBACK_AND_RECOVERY.md#5-indexer-and-projection-recovery).
- [ ] No administrative control can alter protocol state. The controls in
      `src/admin/protocol/` (maintenance mode, emergency actions, service
      control, queue retry) change serving behaviour only.
- [ ] No non-Optimism/EVM runtime path exists. No Stellar/Soroban/Freighter
      dependency, import, or code path. `README.md` describes Stellar as
      *planned*; nothing in the running service may implement it.
- [ ] Outbox payloads carry routing identifiers only — no claim text, no
      settlement data, no PII, no credentials — per the invariant documented on
      `OutboxService`.

Reviewer notes:

```
<findings, or "none">
```

### 4.6 Auth and signature verification

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 6.1 | Wallet signature challenge/response is verified | `POST /auth/challenge` → sign → `POST /auth/login` issues a token only for a valid signature; an invalid or replayed signature is rejected | `UNVERIFIED` | | | |
| 6.2 | Sibling SIWE path is verified | `SiweVerificationService` / `SiweService` nonce handling: nonce is single-use, domain/chain bound, and expiry enforced | `UNVERIFIED` | | | |
| 6.3 | JWT verification is correct | `JWT_SECRET` is production-provided (never the `.env.example` placeholder); `JWT_EXPIRATION` enforced; the algorithm is not attacker-selectable | `UNVERIFIED` | | | |
| 6.4 | Global auth guard covers mutating routes | `GlobalAuthGuard` is registered as `APP_GUARD`; public routes are explicitly `@Public()`; no unintended public write route | `UNVERIFIED` | | | |
| 6.5 | Admin routes are role-gated | `AdminGuard` + `RolesGuard` on `/admin/**`; `AdminRoleHierarchy` respected; a `moderator` cannot reach a `super_admin` route | `UNVERIFIED` | | | |
| 6.6 | Global `ValidationPipe` is strict | `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` (as configured in `src/bootstrap.ts`); mass-assignment is rejected | `UNVERIFIED` | | | |
| 6.7 | Rate limiting is effective and correctly scoped | `WalletThrottlerGuard` active; storage is Redis-backed in production; limits behave as configured after the Redis-loss fallback in 5.5 | `UNVERIFIED` | | | |
| 6.8 | `/metrics` is protected | `MetricsAuthGuard` rejects unauthenticated scrapes; the token is not in the image, the repository, or any log | `UNVERIFIED` | | | |
| 6.9 | Proxy trust is explicit | `TRUSTED_PROXIES` set in production; `trust proxy` is not left unconfigured (it defaults to `false` when unset) | `UNVERIFIED` | | | |
| 6.10 | Optional integrations are not an auth bypass | `ai-assistant` routes require a JWT, including GETs | `UNVERIFIED` | | | |

### 4.7 Secrets management

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 7.1 | No secret in the repository | No credentials, keys, `.env` files, or production addresses committed; the release range spot-checked in history | `UNVERIFIED` | | | |
| 7.2 | `.env.example` contains placeholders only | Values are placeholders (`your_password`, `YOUR_INFURA_KEY`, `your-super-secret-jwt-key-change-in-production`) | `UNVERIFIED` | | | |
| 7.3 | Production secrets come from a secret store | `JWT_SECRET`, `DB_PASSWORD`, `REDIS_PASSWORD`, `SMTP_PASS` and RPC API keys are injected, not baked into the image | `UNVERIFIED` | | | |
| 7.4 | The runtime image ships only what it needs | Confirm what the runtime stage actually copies; audit `node_modules`/lockfile contents in the final image | `UNVERIFIED` | | | |
| 7.5 | Secrets are not logged | No secret appears in application logs, the audit trail, health output, or metric labels | `UNVERIFIED` | | | |
| 7.6 | Runbooks contain no secrets | Every document in `docs/` and `docs/runbooks/` is placeholder-only | `UNVERIFIED` | | | |
| 7.7 | Image and dependency scans are clean at the required severity | Trivy: no unfixed `CRITICAL`/`HIGH` (the bar CI enforces); `npm audit --audit-level=high`; CodeQL clean | `UNVERIFIED` | | | |

### 4.8 Observability and alerting

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 8.1 | Health endpoints respond and are meaningful | `/health`, `/health/live`, `/health/ready`, `/health/startup`, `/health/dependencies`, `/health/indexer` return correct status codes and populate `dependencies` with `responseTimeMs` / `lastSuccessfulCheck` | `UNVERIFIED` | | | |
| 8.2 | `/health` diagnostics are real, not placeholders | `diagnostics.database` (connectivity, latency, `migrationsApplied` / `migrationsPending`, pool counters) and `diagnostics.memoryUsage` / `cpuUsage` contain values | `UNVERIFIED` | | | |
| 8.3 | Prometheus metrics scrape successfully | `GET /metrics` returns text format including `http_requests_total`, `http_request_duration_seconds`, `process_memory_usage_bytes`, `process_cpu_usage_microseconds`, `queue_jobs_total` and the `indexer_*` family | `UNVERIFIED` | | | |
| 8.4 | Indexer metrics are present and correct | `indexer_observed_head`, `indexer_safe_block`, `indexer_finalized_block`, `indexer_projection_head`, `indexer_projection_lag_blocks`, `indexer_rpc_failures_total`, `indexer_replay_count_total`, `indexer_dead_letters_total` | `UNVERIFIED` | | | |
| 8.5 | Outbox metrics are present | `outbox_batch_processed_total`, `outbox_events_dispatched_total`, `outbox_events_relay_failed_total`, `outbox_events_dead_lettered_total` | `UNVERIFIED` | | | |
| 8.6 | Alerts fire for real conditions | Every threshold in [../indexer-runbook.md](../indexer-runbook.md) and in [outbox-notification-delivery.md](outbox-notification-delivery.md) has a firing rule, and each was triggered at least once in this environment | `UNVERIFIED` | | | |
| 8.7 | Alert routing reaches a human | Each alert has a destination a responder actually watches | `UNVERIFIED` | | | |
| 8.8 | Health output is sanitized | No credential, RPC URL, or PII in `/health`, `/health/indexer`, or `/metrics` | `UNVERIFIED` | | | |
| 8.9 | Latency is within the documented budget | [../MONITORING_GUIDE.md](../MONITORING_GUIDE.md) states average `< 100ms`, p95 `< 250ms`, p99 `< 500ms`, slow query `> 100ms`. **Record measured values; do not assert the target was met without the measurement.** | `UNVERIFIED` | | | |
| 8.10 | Profiling is usable and its overhead is bounded | `/profiler/dashboard`, traces, flame graphs, snapshots and regression comparison all function; overhead within the documented `< 1ms` | `UNVERIFIED` | | | |

> **8.6 deserves emphasis.** An alert rule that has never fired is an
> assumption, not a control. Triggering each threshold deliberately in this
> environment and observing the notification is the difference between "we have
> alerts" and "we are alerted".

### 4.9 Documentation synchronized

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 9.1 | Health/metrics endpoints documented | Every route in [../indexer-runbook.md](../indexer-runbook.md) and [../MONITORING_GUIDE.md](../MONITORING_GUIDE.md) exists and behaves as described | `UNVERIFIED` | | | |
| 9.2 | Operational runbooks are present and current | `INCIDENT_RESPONSE.md`, `ROLLBACK_AND_RECOVERY.md`, `outbox-notification-delivery.md`, `indexer-runbook.md`, `DISASTER_RECOVERY.md`, `DEPLOYMENT.md`, `OPERATIONS_MANUAL.md` all exist, and no documented command is known-stale | `UNVERIFIED` | | | |
| 9.3 | Runbooks do not contradict each other | Cross-references resolve; no duplicated procedure has drifted | `UNVERIFIED` | | | |
| 9.4 | The dependency baseline is documented | [../NESTJS_BASELINE.md](../NESTJS_BASELINE.md) matches the tree | `UNVERIFIED` | | | |
| 9.5 | Revision notes are current | Each runbook records a dated change entry; stale claims are corrected rather than left standing | `UNVERIFIED` | | | |
| 9.6 | Known limitations are stated, not buried | Unimplemented or unverified areas (e.g. the CI migration-coverage gap and the table-name observation in [§4.2](#42-migrations-from-a-clean-database)) are disclosed in the docs | `UNVERIFIED` | | | |
| 9.7 | `README.md` claims are checked against the code | Where the README describes the stack or endpoints, the code matches | `UNVERIFIED` | | | |

### 4.10 Rollback plan verified

| # | Check | Pass criterion | Status | Owner | Evidence | Date |
| - | ----- | -------------- | ------ | ----- | -------- | ---- |
| 10.1 | Code rollback rehearsed | A previous release is redeployed successfully in this environment | `UNVERIFIED` | | | |
| 10.2 | Migration revert rehearsed | `npm run migration:revert` exercised; the failure cases in [ROLLBACK_AND_RECOVERY.md §3.3](ROLLBACK_AND_RECOVERY.md#33-why-a-migration-revert-can-fail) are confirmed or refuted | `UNVERIFIED` | | | |
| 10.3 | Snapshot restore rehearsed | Restore into a scratch instance succeeds, per [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §5 | `UNVERIFIED` | | | |
| 10.4 | Indexer resume-after-rollback rehearsed | The indexer resumes from its checkpoint after a restart and reconverges | `UNVERIFIED` | | | |
| 10.5 | Outbox redelivery rehearsed | A reset-to-`PENDING` redelivery is confirmed dispatched/delivered, not merely confirmed reset | `UNVERIFIED` | | | |
| 10.6 | Non-revertable cases are understood | The sign-off records which current releases are **not** revertable, and why | `UNVERIFIED` | | | |
| 10.7 | Verification checklist is executable | [ROLLBACK_AND_RECOVERY.md §8](ROLLBACK_AND_RECOVERY.md#8-rollback-verification-checklist) was walked end to end during the rehearsal | `UNVERIFIED` | | | |

### 4.11 Group summary

Fill this in from the tables above. It is the same information as the sign-off
block, kept here so the sheet can be reviewed before anyone signs.

| Group | Checks | PASS | UNVERIFIED | FAIL | BLOCKED | N/A |
| ----- | ------ | ---- | ---------- | ---- | ------- | --- |
| 4.1 Dependency baseline | 6 | | | | | |
| 4.2 Migrations from clean | 7 | | | | | |
| 4.3 Indexer reprocessing | 9 | | | | | |
| 4.4 Reorg / duplicate / stale | 8 | | | | | |
| 4.5 Fail-closed behaviour | 10 | | | | | |
| 4.6 Auth and signature verification | 10 | | | | | |
| 4.7 Secrets management | 7 | | | | | |
| 4.8 Observability and alerting | 10 | | | | | |
| 4.9 Documentation synchronized | 7 | | | | | |
| 4.10 Rollback plan verified | 7 | | | | | |
| **Total** | **81** | | | | | |

---

## 5. No-go record

If any check is `FAIL` or `BLOCKED`, or if the §2 prerequisite is unmet, the
certification is **NO-GO**. Record:

```
Decision      : NO-GO
Date (UTC)    :
Environment   :
Release/branch: <commit SHA>

Blocking findings
| Check | What failed | Evidence | Owner | Target date |
| ----- | ----------- | -------- | ----- | ----------- |
|       |             |          |       |             |

Non-blocking findings accepted
| Check | Why accepted | Who accepted | Revisit by |
| ----- | ------------ | ------------ | ---------- |
|       |              |              |            |

What must change before this can be re-run
<plain list>
```

Re-run the **whole** gate after a blocking finding is fixed. Do not re-run only
the fixed check: a certification is a snapshot of an environment, and a partial
re-run certifies nothing in particular.

---

## 6. Sign-off

**Signing asserts that every row marked `PASS` was personally executed and its
evidence personally inspected** — not that the row was filled in by someone
else, and not that the system "looks fine". Signing while a blocking row in
[§4.5.10](#4510-the-api-is-never-authoritative--blocking-criterion) is
`UNVERIFIED`, `FAIL`, `BLOCKED` or `N/A` is an incorrect signature.

```
CERTIFICATION RECORD — TruthBounty V2 API

Environment certified : <name; how it differs from production>
Chain / chainId       :
Release certified     : <commit SHA>
Lockfile              : <commit / resolved tree>
Artifact versions     : <chainId:address@version, per §2>

Dependency baseline  (4.1)        : <PASS|NO-GO>   verifier: ____________
Migrations from clean(4.2)        : <PASS|NO-GO>   verifier: ____________
Indexer reprocessing (4.3)        : <PASS|NO-GO>   verifier: ____________
Reorg / duplicate / stale (4.4)   : <PASS|NO-GO>   verifier: ____________
Fail-closed behaviour (4.5)       : <PASS|NO-GO>   verifier: ____________
  incl. never-authoritative 5.10  : <PASS|NO-GO>   verifier: ____________
Auth and signatures  (4.6)        : <PASS|NO-GO>   verifier: ____________
Secrets management   (4.7)        : <PASS|NO-GO>   verifier: ____________
Observability/alerts (4.8)        : <PASS|NO-GO>   verifier: ____________
Documentation        (4.9)        : <PASS|NO-GO>   verifier: ____________
Rollback plan        (4.10)       : <PASS|NO-GO>   verifier: ____________

Rows PASS            : <n> / 81
Rows UNVERIFIED      : <n>          -> certification is NO-GO while n > 0
Rows FAIL            : <n>
Rows BLOCKED         : <n>
Rows N/A             : <n>          (each with a written justification)

DECISION             : <GO | NO-GO>
Conditions on GO     : <if any — e.g. an accepted deviation with an expiry date>

Independent signer
  Name               :
  GitHub handle      :
  Did you author the change certified?   <YES -> this certification is void | NO>
  Signature          :
  Date (UTC)         :

Countersigning maintainer (recommended)
  Name               :
  GitHub handle      :
  Signature          :
  Date (UTC)         :
```

A `GO` with any `UNVERIFIED` row remaining is not a certification. It is a
decision to defer, and it belongs in the [§5](#5-no-go-record) no-go record
with the deferred rows listed as blocking findings and target dates.

---

## 7. Re-certification triggers

A `GO` covers one release SHA in one environment. Re-run the gate when any of
these is true:

- A change to the `@nestjs/*` dependency set (see
  [../NESTJS_BASELINE.md](../NESTJS_BASELINE.md) §6).
- A new or modified migration in `src/migrations/`, or a change to
  `prisma/migrations/`.
- A change to a contract artifact, `v2_contract_artifacts`, or the event schema
  registry — i.e. anything V2-BE-149 touches.
- A change to the health checks in `HealthService`, the fail-closed gates in
  `ArtifactRegistryService`, or the quarantine reasons.
- A change to auth, signature verification, or the admin role guards.
- A change to `docker-compose.yml`, the Dockerfile, or the deployment ordering.
- A chain upgrade, or a finality-assumption change (`REQUIRED_CONFIRMATIONS` /
  `CONFIRMATIONS_REQUIRED`).
- After any SEV1 or SEV2 incident whose postmortem produced a preventive action.
  Its action items become new checks, and the gate is re-run with them included.

---

## 8. Change record

| Date | Author | Change |
| ---- | ------ | ------ |
| 2026-09-25 | `DevMuhdishaq (@DevMuhdishaq)` | Created for #504 (V2-BE-150). Checklist and certification record template only — no check in it has been executed, and no readiness claim is made. |

**Revision note.** First revision, and explicitly a template. Written by reading
`package.json`, `package-lock.json`, `src/health/`, `src/auth/`, `src/admin/`,
`src/metrics/`, `src/outbox/`, `src/notifications/`, `src/v2/`, `src/blockchain/`,
`src/indexer/`, `src/config/`, `src/bootstrap.ts`, `src/app.module.ts`,
`src/migrations/`, `.env.example`, `docker-compose.yml` and
`.github/workflows/ci.yml`. **No check in [§4](#4-the-check-table) has been run,
and no environment has been exercised.** Every row reads `UNVERIFIED` for that
reason, and they should still read `UNVERIFIED` until a named person runs them
and links the output. The two observations flagged in
[§4.2](#42-migrations-from-a-clean-database) are readings of the migration
sources and are labelled as such; they are the kind of thing this gate exists to
settle, and they are not settled here.
