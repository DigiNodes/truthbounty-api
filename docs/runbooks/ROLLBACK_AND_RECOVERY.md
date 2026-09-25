# Operations Runbook: Rollback and Recovery

> **Authority boundary.** Smart contracts and finalized canonical events remain
> strictly authoritative. Every procedure here is about the API's derived,
> rebuildable state. A rollback never decides a protocol outcome; it restores
> the API to a state from which it can rebuild from the chain. If a rollback
> would require discarding the chain's record, that is the wrong tool — see
> [§4 When rollback is NOT safe](#4-when-rollback-is-not-safe-roll-forward-is-required).

## How this relates to the existing documents

This is the canonical *decision and procedure* reference. It deliberately does
**not** restate the following, which remain authoritative for their subjects:

| Document | Still the authority for |
| -------- | ----------------------- |
| [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) | Recovery objectives (RTO `< 4h`, RPO real-time), artifact checksum validation, shadow rebuild, indexer bootstrap, chain-reorg response, snapshot restore, weekly backup verification. |
| [../DEPLOYMENT.md](../DEPLOYMENT.md) | Deployment ordering: artifact validation (Trivy), migration-before-startup, `docker-compose up -d`, indexer bootstrap on a fresh deploy. |
| [../OPERATIONS_MANUAL.md](../OPERATIONS_MANUAL.md) | Profiling dashboard, flame graphs, release baseline/compare snapshots, sampling strategies. |
| [../indexer-runbook.md](../indexer-runbook.md) | Indexer signal definitions, alert thresholds, replay semantics, `GET /health/indexer` interpretation. |
| [outbox-notification-delivery.md](outbox-notification-delivery.md) | Outbox metrics, dead-letter diagnosis and the `DEAD_LETTER` → `PENDING` reset. |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Declaration, severity, roles, communications, escalation, fail-closed vs fail-open, postmortem. |

This document answers the three questions those documents do not: **should I
roll back or roll forward**, **how exactly do I roll a migration back when the
revert can fail**, and **how do I verify a rollback actually worked**.

---

## 1. Before you touch anything

```bash
# 1. What is deployed, and what schema is it expecting?
docker compose ps
docker compose images
docker compose logs --tail=200 api

# 2. What does the database think is applied? (Reports applied vs pending; applies nothing on a clean tree.)
npm run migration:run

# 3. What does the service think of itself?
curl -sS http://<api-host>:3000/health
curl -sS http://<api-host>:3000/health/ready
curl -sS http://<api-host>:3000/health/indexer

# 4. Do you have a pre-change snapshot/pg_dump? Name it now, out loud, in the record.
#    If you do not, that is your first finding in the postmortem.
```

Take a **fresh** pre-change snapshot before any further change, per
[../DEPLOYMENT.md](../DEPLOYMENT.md) §Rollback Procedures. A rollback path
without a snapshot is a guess.

> **`npm run migration:run` on a tree with no pending migrations is a read.**
> That is the intended way to see applied-vs-pending. It is *not* a substitute for
> a snapshot, and if the tree does have pending migrations, stop and read this
> document before running it.

---

## 2. Decision rule: roll back or roll forward

Ask these in order. Stop at the first **yes**.

1. **Did a migration land in production?** → Roll back the **code** only if the
   previous code can run against the current schema. Check by reading the
   previous version's entity/migration expectations. If it cannot, go to §4.1.
2. **Is the previous version's schema reachable?** i.e. can
   `npm run migration:revert` produce a schema the previous code runs against,
   without dropping data that has since been written? → If **no**, go to §4.2.
3. **Is the defect in this release, and is the previous version known-good on
   this exact configuration?** → **Roll back.** Go to §3.
4. **Is the cause external and self-correcting** (a provider blip, a Redis
   restart, a transient reorg, a rate limit) with no code or schema defect
   identified? → **Do not roll back.** Rolling back removes a working process to
   fix a dependency. Contain and wait; recover the dependency per §6.
5. **Has the chain moved on in a way the previous code cannot follow?** (new event
   type, new contract artifact, a deployment that the old ABI cannot decode) →
   **Roll forward.** Go to §4.3. Rolling back would make the indexer unable to
   decode current chain activity, which is strictly worse.
6. **Is the data written by the new version usable and correct, with only the
   behaviour wrong?** → **Roll forward with a hotfix.** Reverting the schema
   would discard correct data to fix a code bug.

### 2.1 Triage summary

| Cause | Action |
| ----- | ------ |
| Code regression, previous version known-good, no migration landed | Roll back code (§3.1) |
| Code regression **with** a backward-compatible migration | Roll back code only; leave the schema (§3.1) |
| Code regression **with** a destructive migration | Almost always roll forward (§4.1, §4.2) |
| Bad deployment: image/tag, config, env var | Roll back code/config (§3.1, §3.4) |
| Provider/dependency outage, no code defect | Contain; do **not** roll back (§6) |
| Bad chain event (deep reorg, quarantine spike, artifact drift) | Reprocess, not roll back (§5) |
| Bad data written by the new version | Fix forward; if unrecoverable, restore the snapshot per [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §5, then reprocess from the checkpoint (§5) |

---

## 3. Roll back

### 3.1 Code rollback

**Image / orchestrated deployment** (the normal production path). The general
form is in [../DEPLOYMENT.md](../DEPLOYMENT.md) §Rollback Procedures step 1: revert
to the previous stable image tag.

```bash
# Pin the previous tag and roll. Substitute your orchestrator's actual command.
docker compose pull
docker compose up -d --no-deps api
docker compose ps
docker compose logs --tail=200 api
```

**docker-compose from the repository** (development / the compose file in this
repo). The compose file builds from `.` and runs `npm run start:dev`; there is
no image tag to revert to, so roll back the *source* instead:

```bash
git log --oneline -5
git revert --no-edit <bad-commit>     # preferred: keeps history honest
# or, for a local/unpushed branch only:
git checkout <good-commit>
```

**Bare host / process manager.** `npm run start:prod` runs `node dist/main`, so
the build output is the artifact that matters:

```bash
git revert --no-edit <bad-commit>
npm ci
npm run build
# then restart under whatever supervises `npm run start:prod`
```

**Do not** roll back `package.json` / `package-lock.json` independently of the
code. They are one artifact. If you are reverting a dependency change, revert
the commit that changed them and re-run `npm ci` — see
[../NESTJS_BASELINE.md](../NESTJS_BASELINE.md) for what the guard checks about
that set.

**Maintenance mode during a rollback.** For a rollback that will take more than
the deploy window, put the service into maintenance mode so requests are served
deliberately rather than by a half-reverted process. Requires
`SUPER_ADMIN`/`ADMINISTRATOR`:

```bash
curl -sS -X POST http://<api-host>:3000/admin/protocol/maintenance \
  -H "Authorization: Bearer <admin-jwt>" -H 'Content-Type: application/json' \
  -d '{"enabled": true, "reason": "<incident id> rollback in progress"}'
# ... roll back ...
curl -sS -X POST http://<api-host>:3000/admin/protocol/maintenance \
  -H "Authorization: Bearer <admin-jwt>" -H 'Content-Type: application/json' \
  -d '{"enabled": false, "reason": "<incident id> rollback complete"}'
```

Rollback steps and their decision rules are in
[INCIDENT_RESPONSE.md §9](INCIDENT_RESPONSE.md#9-operational-controls-during-an-incident).
The IC owns the decision; the operator executes it.

### 3.2 Database migration rollback

Migrations are TypeORM, in `src/migrations/`, applied by
`src/config/data-source.ts` (PostgreSQL when `DATABASE_URL` is set, SQLite
fallback otherwise; `synchronize: false` for PostgreSQL, so migrations are the
only schema path in production).

```bash
# See the state first
npm run migration:run      # reports applied vs pending

# Revert exactly one migration — the last applied one
npm run migration:revert
```

`migration:revert` reverts **one** migration per invocation. Reverting N
migrations means running it N times, in reverse order, checking state between
each. Do not batch it.

Other scripts in the same family, for completeness: `npm run migration:generate`
(diff the entities against the schema and emit a migration),
`npm run migration:create` (empty migration skeleton).

**CI note.** `.github/workflows/ci.yml` "Run migration tests" runs
`npx prisma migrate reset --force` followed by `npx prisma migrate deploy`. That
exercises the **Prisma** migrations in `prisma/migrations/`, not the TypeORM
migrations in `src/migrations/`. The 17 TypeORM migrations are therefore **not**
covered by that CI step. Do not read a green CI run as evidence that
`npm run migration:run` or `npm run migration:revert` works. That gap is one of
the reasons [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) exists.

### 3.3 Why a migration revert can fail

Every migration in `src/migrations/` declares an `async down()`, so a revert is
always *attempted*. "Has a `down()`" is not the same as "is safe". Four concrete
failure modes, each with a real example from this repository:

**(a) Re-adding a constraint that new data now violates.**
`src/migrations/1769500000001-AdjustProcessedEventUniqueIndex.ts` narrows
`processed_events` to `UNIQUE (tx_hash, log_index)` in `up()`. Its `down()`:

```sql
DROP INDEX "IDX_processed_events_tx_hash_log_index";
ALTER TABLE "processed_events"
  ADD CONSTRAINT "UQ_f4bfa3c06d08fd9e7f7a611a7e9" UNIQUE ("tx_hash", "log_index", "block_number");
```

Re-adding the three-column constraint succeeds **only** while no two rows share
`(tx_hash, log_index)` with different `block_number`. If the indexer has written
such rows since the migration landed, the `ALTER TABLE` fails with a unique
violation — after the `DROP INDEX` has already taken effect inside the same
transaction. The migration is transactional, so the revert rolls back cleanly and
leaves the narrow index in place; but you are now stuck: the revert will keep
failing for as long as those rows exist.

Pre-flight:

```sql
SELECT tx_hash, log_index, COUNT(DISTINCT block_number) AS blocks
FROM processed_events
GROUP BY tx_hash, log_index
HAVING COUNT(DISTINCT block_number) > 1
LIMIT 20;
```

If that returns rows, the revert is blocked. Resolve it deliberately (deduplicate
and re-verify against the chain — the raw events are the authority), or roll
forward. **Do not** delete rows to make a constraint apply.

**(b) Dropping data that exists only in the new schema.**
`src/migrations/1769800000000-CreateV2CanonicalEventTables.ts` `down()` is:

```sql
DROP TABLE "v2_event_quarantine";
DROP TABLE "v2_canonical_events";
DROP TABLE "v2_event_checkpoints";
DROP TABLE "v2_contract_artifacts";
```

That is total data loss of canonical events, ingestion checkpoints, the approved
artifact registry, and the quarantine log. It is correct as a schema revert and
catastrophic as an operational one. Same pattern in
`1769800100000-CreateV2EvidenceTables.ts` (drops `v2_project_evidence`,
`v2_project_evidence_version`, `v2_projector_cursors`),
`1769800200000-CreateV2VerificationTables.ts`,
`1769800300000-CreateV2DisputesTables.ts`,
`1769800000000-AddEvidenceRegistrationColumns.ts` (`down()` drops
`transactionHash`, `blockNumber`, `onChainRegistered` from `evidences`),
`1788000000000-AddDeadlineEffectiveAtToClaims.ts` (`down()` drops `effectiveAt`
and `deadline`), `1704067200000-AddAuditLogs.ts` (`dropTable('audit_logs')`).

**Rule: reverting a `CREATE TABLE` migration means the corresponding chain-derived
data is gone from the database.** Recovery is a full reprocess from a checkpoint
or from the chain ([§5](#5-indexer-and-projection-recovery)) — not a data
restore. That is acceptable only when the indexer can deterministically rebuild
everything, which the RPO in [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md)
("indexer deterministically rebuilds from chain data") assumes. Confirm the
assumption for the specific tables before you rely on it.

**(c) A `down()` that references a table or column that does not exist.**
`src/migrations/1769800400000-AddVerificationDisputeEnhancements.ts` alters and
drops columns on `v2_project_verification_rounds`,
`v2_project_participant_positions` and `v2_project_disputes` (plural). The
entities and the creating migrations use the **singular** names:
`v2_project_verification_round`, `v2_project_participant_position`
(`src/v2/verification/entities/*.entity.ts`,
`src/migrations/1769800200000-CreateV2VerificationTables.ts`) and
`v2_project_dispute` (`src/v2/disputes/entities/project-dispute.entity.ts`,
`src/migrations/1769800300000-CreateV2DisputesTables.ts`).

Observed by reading the files; **not** executed here. If those plural names are
not present in a given database, both the migration's `up()` and its `down()`
fail on the missing relation. Treat this as a specific, checkable item in
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) §"Migrations verified from a
clean database" rather than as a verified defect — a maintainer must run
`npm run migration:run` against a clean PostgreSQL database and record the
result.

Pre-flight for any revert:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'v2_%'
ORDER BY table_name;
```

Compare that list against every identifier the `down()` touches before running it.

**(d) Index drops qualified for a schema that is not there.**
`1769500000000-OptimizeClaimIndexes.ts` and several others `DROP INDEX
"public"."<name>"`. If the index is missing — because a later migration already
dropped it, or because it was never created — the revert fails. Index-only
reverts are the least dangerous kind; they are also the most likely to fail for
this reason. `IF EXISTS` semantics are not guaranteed in the SQL these files
emit.

### 3.4 Configuration and secret rollback

Environment is read from `.env.local` then `.env` via `ConfigModule.forRoot`
(`src/app.module.ts`), and container deployments use `.env.docker`
(`docker-compose.yml`). Relevant names, from `.env.example` and the config
registries:

| Concern | Variables |
| ------- | --------- |
| Database | `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL`, `DATABASE_SSL`, `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT`, `DB_POOL_ACQUIRE_TIMEOUT`, `DB_POOL_RETRIES`, `DB_POOL_RETRY_DELAY`, `DATABASE_SYNCHRONIZE`, `DATABASE_LOGGING` |
| Redis | `REDIS_ENABLED`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_TLS` |
| Chain | `BLOCKCHAIN_RPC_URL`, `OPTIMISM_RPC_URL`, `CHAIN_ID`, `REWARD_CONTRACT_ADDRESS`, `START_BLOCK`, `REQUIRED_CONFIRMATIONS`, `CONFIRMATIONS_REQUIRED`, `BLOCK_RANGE_PER_BATCH`, `MAX_RETRY_ATTEMPTS`, `POLLING_INTERVAL_MS`, `INDEXED_CONTRACTS` |
| Indexer memory | `BLOCKCHAIN_MAX_BLOCKS`, `BLOCKCHAIN_MAX_EVENTS`, `BLOCKCHAIN_MAX_REORG_HISTORY` |
| Auth | `JWT_SECRET`, `JWT_EXPIRATION` |
| Notifications | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `NOTIFICATION_QUEUE_DELAY`, `NOTIFICATION_MAX_RETRIES`, `NOTIFICATION_RETRY_DELAY` |
| Realtime | `REALTIME_POLL_INTERVAL_MS`, `REALTIME_MAX_PUBLISH_BATCH`, `REALTIME_HEARTBEAT_INTERVAL_MS`, `REALTIME_MAX_BACKLOG`, `REALTIME_MAX_REPLAY_ROWS` |
| Runtime | `NODE_ENV`, `PORT`, `TRUSTED_PROXIES` |

Two of these deserve specific care:

- **`DATABASE_SYNCHRONIZE`.** `.env.example` warns "Set to 'true' only in
  development (auto-sync schema)". `src/config/data-source.ts` hard-codes
  `synchronize: false` on the PostgreSQL path, so the env var cannot enable
  auto-sync in production through the CLI datasource — but do not rely on that as
  the control. Never set it `true` anywhere near a real database; `synchronize`
  derives schema from entities and will happily drop what it thinks is stale.
- **`INDEXED_CONTRACTS`.** This is the list of addresses the indexer watches, and
  the decoder only decodes addresses with an **approved** artifact
  (`v2_contract_artifacts.isApproved = true`; see
  [INCIDENT_RESPONSE.md §7](INCIDENT_RESPONSE.md#7-chain-derived-state-during-an-incident)).
  Restoring an old `INDEXED_CONTRACTS` value to "roll back" will silently stop
  ingest for contracts added since. Check the diff of this variable before
  reverting it, and reconcile `v2_contract_artifacts` with it deliberately.

Secrets are never part of a code rollback. A secret that was exposed is rotated
through the secret store and the rotation is recorded — see
[SECURITY.md](../../SECURITY.md) and
[INCIDENT_RESPONSE.md §5.3](INCIDENT_RESPONSE.md#53-what-must-never-appear-in-a-status-update).

---

## 4. When rollback is NOT safe (roll forward is required)

Explicit list. Each of these is a case where reverting makes the system worse.

### 4.1 The previous code cannot run against the current schema

The release both changed behaviour **and** changed the schema in a way the old
code does not expect. Reverting the code alone leaves a mismatch; reverting the
schema discards data written under the new schema. In this situation: keep the
current code, fix forward, and accept the release is not revertable. Say so
explicitly in the incident record — "this release is not revertable" is
information the IC needs immediately, and discovering it during a revert window
is how a SEV2 becomes a SEV1.

Practical test: read the previous version's entity definitions and confirm the
current schema satisfies them. If the previous version selects a column the new
migration added as `NOT NULL` without a default, it cannot run.

### 4.2 The revert would drop data that only exists in the new schema

§3.3(b) and §3.3(a) both. Once the indexer has written rows that the `down()`
would delete or that would block a re-added constraint, the schema revert is
loss-making. Recovery paths, in preference order:

1. Fix forward with a corrective migration (a new `up()`), never by editing a
   migration that has already run anywhere.
2. Reprocess the affected data from the chain ([§5](#5-indexer-and-projection-recovery)).
3. Restore a pre-change snapshot **and** reprocess from the checkpoint, accepting
   the gap. Snapshot restore is in
   [../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §5.

**Never** hand-delete or hand-insert rows to satisfy a constraint or to make a
revert apply. The raw chain events are the authority; the database is a cache of
them.

### 4.3 The chain has moved past what the previous code can follow

If the previous version's ABI cannot decode an event the chain is now emitting,
rolling back does not "restore" anything — it turns a decode failure into a
whole-index decode failure. Same reasoning for a newly deployed contract whose
artifact the previous artifact registry does not contain. Fix the artifact, then
fix forward; if the new code is the problem, fix the new code forward.

### 4.4 The defect is external, not in this release

A provider outage, a Redis restart, a transient reorg, a rate limit, a
certificate expiry: rolling back a working process does not fix any of them, and
it throws away warm state and a known-good schema alignment. Contain, wait, and
recover the dependency per §6. Rolling back during a dependency outage also
destroys the evidence you need — the in-memory cursor and `lastSuccess`
timestamps in `HealthService` are reset by the restart.

### 4.5 A migration revert is running and has partially applied

TypeORM migrations run in a transaction, so a failing `down()` normally rolls
back. But if you are using `migration:run`/`migration:revert` against a
non-transactional path, or you have run hand-written DDL, you may be in a
partial state. **Do not keep re-running the revert.** Stop, take a snapshot,
enumerate the actual schema, and reconcile deliberately:

```sql
SELECT * FROM migrations ORDER BY timestamp DESC LIMIT 20;   -- TypeORM bookkeeping table
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname;
```

`HealthService.collectDiagnostics` also surfaces `migrationsApplied` and
`migrationsPending` in the `GET /health` `diagnostics.database` block, which is
a cheap cross-check that the bookkeeping table and the entity set agree.

### 4.6 Rollback would lose the audit trail

`audit_logs` and the audit entries written by `AuditTrailService` are how the
incident is reconstructed afterwards. A revert that drops them destroys the
evidence for the very event you are rolling back. If a revert would touch
`audit_logs`, take a `pg_dump` of it first, out of band.

### 4.7 You are rolling back to fix a fabrication

If the reason for the rollback is that the system served wrong protocol state,
rolling back the code does not un-serve it. The priority order is: stop serving
it (maintenance mode or the correct fail-closed behaviour), then fix forward, and
treat it as `security_breach`-class per
[INCIDENT_RESPONSE.md §6.1](INCIDENT_RESPONSE.md#61-escalation-ladder).

---

## 5. Indexer and projection recovery

Signal definitions, thresholds and the canonical remediation steps live in
[../indexer-runbook.md](../indexer-runbook.md). This section is the recovery
mechanics.

### 5.1 Where progress is recorded

Five distinct places, because the pipeline has more than one layer. Know which
one you are resetting before you touch it.

| Store | Entity | Meaning |
| ----- | ------ | ------- |
| `v2_event_checkpoints` | `EventCheckpoint` (`src/v2/events/entities/event-checkpoint.entity.ts`) | Per `(chainId, contractAddress)` ingestion cursor: `lastSafeBlock`, `lastFinalizedBlock`. Advanced **in the same transaction** as the canonical-event write, and monotonically (never moved backward). |
| `v2_canonical_events` | `CanonicalEvent` | The decoded, normalized event record. Unique on `(chainId, txHash, logIndex)`. |
| `v2_projector_cursors` | `ProjectorCursor` (`src/v2/common/entities/projector-cursor.entity.ts`) | How far each projector (evidence, verification, disputes) has consumed. A resumption optimization; the projectors' own unique constraints on `(eventTxHash, eventLogIndex)` are the real idempotency mechanism. |
| `indexer_checkpoint` | `IndexerCheckpoint` (`src/blockchain/entities/indexer-checkpoint.entity.ts`) | The older single-row `lastBlock` cursor. |
| In-memory | `BlockchainStateService` (`src/blockchain/state.service.ts`) | `observedHeadBlock`, `safeBlock`, `finalizedBlock`, `projectionHeadBlock`, plus counters. **Lost on restart.** Bounded by `BLOCKCHAIN_MAX_BLOCKS` / `_EVENTS` / `_REORG_HISTORY` (default 10000 / 50000 / 1000). |

`ReorgSafeCursorService` (`src/indexer/reorg-safe-cursor.service.ts`) writes
`v2_indexer_cursors` and `v2_projections` in one `QueryRunner` transaction —
cursor and projections commit or neither does. Preserve that atomicity in any
recovery step.

### 5.2 Restart to resume from the persisted checkpoint

The cheapest recovery, and the first thing to try when the indexer is stuck but
the checkpoint is intact.

```bash
# Operational restart via the indexer controller (no redeploy)
curl -sS -X POST http://<api-host>:3000/indexer/restart

# Or restart the process
docker compose restart api
```

The indexer resumes from its persisted checkpoint. Watch it catch up:

```bash
curl -sS http://<api-host>:3000/indexer/status
curl -sS http://<api-host>:3000/health/indexer     # projectionLag should fall
```

Note: the in-memory state service is cleared by a restart, so `observedHeadBlock`,
`safeBlock`, `finalizedBlock` and `projectionHeadBlock` all read 0 until the
first poll repopulates them. A `GET /health/indexer` in that window can report
`unhealthy` for missing cursors, which is why the health check treats missing
cursors as a fail-closed condition. That is expected during a restart and is not
by itself a new incident.

### 5.3 Reprocess a block range

```bash
# Backfill a specific contract from a specific block
curl -sS -X POST http://<api-host>:3000/indexer/backfill \
  -H 'Content-Type: application/json' \
  -d '{"contractAddress":"<0x...>","blockNumber":<N>}'
```

`EventIndexerService.backfillFromBlock(contractAddress, blockNumber)` — both
fields are required; the controller returns `success: false` with
`"contractAddress and blockNumber are required"` otherwise.

**Replay is safe and idempotent**, per
[../indexer-runbook.md](../indexer-runbook.md) §Rebuild / replay impact, and the
code backs that up:

- `v2_canonical_events` is unique on `(chainId, txHash, logIndex)`;
  `CanonicalEventsService.ingest` catches the Postgres `23505` unique violation
  and returns `{ status: 'duplicate' }` instead of throwing.
- `v2_event_quarantine` is unique on `(chainId, txHash, logIndex)`, and the
  quarantine write swallows the same violation, so quarantine is idempotent too.
- Projector writes are guarded by unique constraints on
  `(eventTxHash, eventLogIndex)`.
- Replays are observable: `indexer_replay_count_total` increments via
  `recordReplay`.

So reprocessing is the correct recovery for a projector defect, a quarantine
spike, or a projection that drifted — and it is *much* safer than a schema
revert, because it loses nothing.

### 5.4 When quarantine is the actual problem

`v2_event_quarantine` holds logs that were **not** dropped and **not**
force-decoded. Reasons: `unregistered_address`, `unknown_signature`,
`artifact_drift`, `decode_error`. Queries are in
[INCIDENT_RESPONSE.md §7.1](INCIDENT_RESPONSE.md#71-quarantine-and-outbox-inspection-queries).

Recovery per reason:

| Reason | What it means | What to do |
| ------ | ------------- | ---------- |
| `unregistered_address` | No row in `v2_contract_artifacts` with `isApproved = true` for that address. | **Do not approve the address to clear the queue.** Verify the address and ABI against the canonical artifact first. An unapproved address is a fail-closed stop, and that is the system working. Approving an unverified address converts a visible stop into a silent wrong decode. |
| `unknown_signature` | `topic0` matched no fragment in the approved ABI. | The artifact is missing an event the contract now emits. Get the canonical artifact, register the new version, `ArtifactRegistryService.clearCache()`, then reprocess the range. |
| `artifact_drift` | The event decoded but has no canonical schema mapping in the event schema registry. | A mapping gap, not a decode gap. Add the mapping, then reprocess. Do not bypass the mapping. |
| `decode_error` | The decode threw. | Usually a mismatched ABI for the deployed bytecode. Same as `unknown_signature`: fix the artifact against the canonical source, then reprocess. |

After any artifact change: clear the in-memory artifact cache (via
`ArtifactRegistryService.clearCache()`, i.e. a process restart is sufficient and
simplest), then reprocess the affected range per §5.3.

### 5.5 Full rebuild

For corruption or a lost database, the procedures are in
[../DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) §3 (indexer bootstrap) and
§2 (shadow rebuild). The rollback-specific point: **a full rebuild does not
require a database rollback.** It requires the chain. Because the RPO is
"real-time (indexer deterministically rebuilds from chain data)", a rebuild is
strictly safer than a schema revert whenever the two are otherwise equivalent —
prefer it.

---

## 6. Dependency-degradation recovery

Which knob to use per dependency, and what "recovered" means. The fail-closed /
fail-open classification of each dependency is in
[INCIDENT_RESPONSE.md §8](INCIDENT_RESPONSE.md#8-fail-closed-vs-fail-open-per-dependency)
and is not repeated here.

| Dependency | Degraded behaviour (read it here) | Recovery | Verify with |
| ---------- | --------------------------------- | -------- | ----------- |
| **PostgreSQL** | Fail closed. `/health/ready` → 503; `GET /health` reports `database` `unhealthy` with a `failureReason`. No reads are served from cache to "stay up". | Restore connectivity, or fail over per your HA setup. Confirm the pool recovers (`diagnostics.database.poolTotal` / `poolIdle` / `poolActive` / `poolWaiting` in `GET /health`). Then `npm run migration:run` to confirm the schema is fully applied — a restore from backup can land the schema behind the code. | `/health/ready` 200, `database` `healthy`, `migrationsPending` 0 |
| **Redis** | Fail open. Caching bypassed, reads hit the database. Two documented consequences: (i) `RedisService.setnx` returns `true` when Redis is down, so the fast idempotency guard is skipped and `NotificationProcessor` falls back to the DB guard — correct, slower, no duplicate deliveries; (ii) `createThrottlerStorage` falls back to in-memory throttler storage, so **rate limits become per-instance and weaker**. | Restore Redis (`redis-cli ping`). `RedisService` stops retrying after 3 attempts, so the client must be re-established by a process restart, not left to retry. Restart the process so caches and the throttler storage are rebuilt cleanly. Watch for a thundering-herd cache refill afterwards. | `/health` `redis` `healthy`; `redis-cli ping`; rate limiting effective cluster-wide again (do not verify by hammering the API — verify by reading the storage the process selected) |
| **BullMQ queues** | Fail closed on reachability — but note the health check tests *reachability*, not depth. A healthy queue with a huge backlog still reports `healthy`. | Inspect depth at `/admin/queues` or `GET /admin/protocol/queues` (`waiting`, `active`, `completed`, `failed`, `delayed`, `paused` per queue, plus `totalWaiting`/`totalActive`/`totalFailed`). Retry failed jobs: `POST /admin/protocol/queues/retry-failed?queueName=<queue>`. Pause while fixing a consumer: `POST /admin/protocol/services/control` with `serviceType: "queue"`, `action: "pause"`, `queueName: "<queue>"`. | Queue depth falling; `failed` counter falling; `totalWaiting` trending to 0 |
| **Indexer / RPC** | Fail closed on missing cursors. `degraded` when projection lag, the RPC failure rate in window, or dead letters exceed their thresholds; `unhealthy` when head/finalized/RPC counters are missing. | Follow [../indexer-runbook.md](../indexer-runbook.md) §Remediation steps. Then reprocess if events were lost (§5.3). | `GET /health/indexer` back to `healthy`; `projectionLag` within threshold; `indexer_dead_letters_total` flat |
| **Notifications** | Fail open. `degraded` when queue depth exceeds the 1000 threshold checked by `checkNotifications`. | If the backlog is compounding, `disable_notifications` stops new work at the source; then recover the channel (SMTP, webhook receiver) and drain. Coordinate with comms — users stop hearing from the API entirely while it is disabled. | `GET /health` `notifications` `healthy`; queue depth falling |
| **IPFS** | Fail open. `degraded` when an upload does not return a CID. | Restore the provider. Nothing that decides protocol state depends on it, so this is the lowest-priority dependency. | `GET /health` `ipfs` `healthy` |

**Never** respond to a dependency incident by rolling back the application
([§4.4](#44-the-defect-is-external-not-in-this-release)). Contain, recover the
dependency, and let the health signals return on their own.

---

## 7. Outbox and notification redelivery

**Not duplicated here.** The metrics, the alerting thresholds, the dead-letter
diagnostic query, and the `DEAD_LETTER` → `PENDING` reset are all in
[outbox-notification-delivery.md](outbox-notification-delivery.md). Go there for
the procedure.

Three rollback-specific facts about that system, which that runbook does not
cover and which matter when you are recovering rather than investigating:

1. **Relay parameters** (`src/outbox/outbox.service.ts`): jobs are added to the
   `notifications` queue as `deliver-notification` with
   `attempts: 5`, `backoff: { type: 'exponential', delay: 1000 }`,
   `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`, and a
   **deterministic** `jobId: 'outbox-${idempotencyKey}'`. Batches of 50 per poll
   (`BATCH_SIZE`), poller on `CronExpression.EVERY_5_SECONDS`
   (`OutboxScheduler`).
2. **The deterministic `jobId` is what makes redelivery tricky.** The
   idempotency key is `sha256(eventType:aggregateId:channel:sortedRecipientIds)`.
   If a completed job with that id is still retained (BullMQ keeps the last 100
   completed jobs), re-adding the same id will not create a second job — so
   resetting an outbox row to `PENDING` after its job already ran and completed
   may re-queue nothing at all. Conversely if the job was trimmed, the re-add
   creates a fresh job. **Therefore, after a redelivery reset, confirm the
   outcome rather than assuming it:** check the row's `status`/`jobId` and the
   notification's delivery history, not just that the reset SQL returned success.
3. **The idempotency guards are layered, and only one is authoritative.** The
   Redis `SETNX` guard (`idempotency:notification:${key}`, 24h TTL) is a fast
   path; the database guard (`DeliveryHistory.findByIdempotencyKey`) is
   authoritative. If Redis was unavailable, `setnx` returns `true` and the DB
   guard decides. A redelivery reset that clears the `SETNX` key but not the
   `DeliveryHistory` row will still be suppressed — correctly. If you are
   redelivering **because** the previous delivery genuinely failed, confirm the
   `DeliveryHistory` status is not `DELIVERED` before resetting, or you will
   chase a delivery that is being correctly suppressed.

Dead-letter triage, alert thresholds (`outbox_pending_count > 500`,
`outbox_dead_letter_count > 10`) and the metrics
(`outbox_batch_processed_total`, `outbox_events_dispatched_total`,
`outbox_events_relay_failed_total`, `outbox_events_dead_lettered_total`) are in
[outbox-notification-delivery.md](outbox-notification-delivery.md).

---

## 8. Rollback verification checklist

Do not declare the rollback complete until every line is checked. A rollback
that is not verified is an incident that is still open.

### 8.1 Process

- [ ] `/health/live` returns `200` with a plausible `uptime` for the *newly
      started* process (a large uptime means you did not actually restart).
- [ ] `/health/ready` returns `200` and `ready: true`. A `503` here is a
      fail-closed dependency, not a failed rollback — find which one.
- [ ] `docker compose ps` / orchestrator shows the intended tag, and
      `docker compose images` matches it.
- [ ] Application logs show a clean start: no migration errors, no
      `Health check failed for <dependency>` warnings beyond the expected
      degraded ones, no crash loop.
- [ ] Swagger/`/api` loads, so the DI graph is complete.

### 8.2 Dependencies

- [ ] `GET /health` `summary` accounted for: every dependency is `healthy`, or
      is a **named and accepted** `degraded`.
- [ ] `GET /health` `diagnostics.database.migrationsPending` is `0`.
- [ ] `GET /health/indexer` is `healthy` (or the residual `degraded` is
      understood and improving): `observedHeadBlock`, `safeBlock` and
      `finalizedBlock` are non-zero and rising, `projectionLag` is inside
      `alertThresholds.projectionLagBlocks`.
- [ ] Queues are flowing: `GET /admin/protocol/queues` shows `waiting` falling
      and no unexpected `paused`.

### 8.3 Data and chain consistency

- [ ] `v2_event_checkpoints.lastSafeBlock` is advancing.
- [ ] `v2_projector_cursors` are advancing.
- [ ] `v2_event_quarantine` row count is not growing (or the growth is explained
      and attributed to a known cause).
- [ ] No manual edits were made to projections, canonical events, checkpoints or
      cursors during the incident. If any were, they are recorded, and the
      affected ranges are reprocessed from the chain.

### 8.4 Outbox

- [ ] `outbox_pending_count` is falling.
- [ ] `outbox_dead_letter_count` is flat or falling.
- [ ] Any rows you reset to `PENDING` for redelivery are confirmed dispatched or
      delivered — not merely confirmed reset ([§7](#7-outbox-and-notification-redelivery)).

### 8.5 Controls

- [ ] Maintenance mode is **off** (if it was used) —
      `GET /admin/protocol/maintenance` → `active: false`.
- [ ] No emergency action is left active —
      `GET /admin/protocol/status` → `emergencyActive: false`,
      `activeEmergencies: []`.
- [ ] Throttling is back to the intended setting —
      `apiThrottlingActive` matches the pre-incident value.
- [ ] Any paused queue is resumed.

### 8.6 Process hygiene

- [ ] The IC has explicitly declared all-clear.
- [ ] The scribe's timeline is complete through the verification.
- [ ] If anything in this checklist could not be checked, it is stated in the
      all-clear message rather than omitted from it. An honest "unverified: X" is
      required; a silent omission is what the checklist exists to prevent.

Once the all-clear is posted, the post-incident review proceeds per
[INCIDENT_RESPONSE.md §10](INCIDENT_RESPONSE.md#10-post-incident-review).

---

## 9. Change record

| Date | Author | Change |
| ---- | ------ | ------ |
| 2026-09-25 | `DevMuhdishaq (@DevMuhdishaq)` | Created for #502 (V2-BE-147). Reconciles with, and does not duplicate, `DISASTER_RECOVERY.md`, `DEPLOYMENT.md`, `OPERATIONS_MANUAL.md`, `indexer-runbook.md` and `runbooks/outbox-notification-delivery.md`. |

**Revision note.** First revision. Every command, endpoint, DTO field, table
name, column name, enum value and metric name in this document was read from the
tree (`package.json`, `src/migrations/`, `src/outbox/`, `src/blockchain/`,
`src/indexer/`, `src/v2/`, `src/health/`, `src/admin/`, `src/config/`,
`.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`). **No command
in this document was executed.** In particular:

- No `npm run migration:run` or `npm run migration:revert` was run, so
  [§3.3(c)](#33-why-a-migration-revert-can-fail)'s table-name observation is a
  reading of the migration sources, not a reproduced failure.
- No dependency was taken down, so [§6](#6-dependency-degradation-recovery)
  describes the fail-open/fail-closed behaviour that the code implements rather
  than an observed outage.
- No rollback was performed.

The first real exercise of this runbook should correct its ordering and its
`§3.3` pre-flight queries, and that correction should be recorded here.
