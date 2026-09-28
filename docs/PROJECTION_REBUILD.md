# Projection Rebuild Pipeline (V2-BE-019)

> **Scope.** How to deterministically rebuild every V2 read model from the
> persisted canonical event log, starting at a configured deployment block;
> how to resume an interrupted rebuild; how to read the reconciliation report;
> and the exact procedure for cutting a rebuilt read model over to live.
>
> Related: [`indexer-runbook.md`](./indexer-runbook.md) (lag/finality
> alerting), [`load-budgets.md`](./load-budgets.md) (read-path budgets),
> [`V2_REWARD_ALLOCATION_AUDIT.md`](./V2_REWARD_ALLOCATION_AUDIT.md) (what the
> rebuilt reward projection contains).

---

## 0. What already existed, and what this adds

The repository already had three partial capabilities. None of them was a
rebuild, and this section is explicit about the difference so the diff reads
honestly.

| Prior art | Path | What it did | Why it was not a rebuild |
| --------- | ---- | ----------- | ------------------------ |
| Per-claim reprojection | `ClaimProjectorService.reproject` — `src/claims/claim-projector.service.ts` | Replays one claim's stored lifecycle events into its read model | Per-claim, not full-schema; driven by the `ClaimLifecycleEvent` table, not the canonical event log; no checkpoint, no report, no cross-projection coordination |
| Cursor rewind | `EventIndexerService.backfillFromBlock` — `src/indexer/event-indexer.service.ts` | Moves `lastProcessedBlockNumber` back so the RPC poller re-fetches a range | Rewinds an *ingestion* cursor, not a projection cursor. Re-fetches from RPC, applies into a **non-empty** live schema, and is neither resumable nor reportable |
| Outbox idempotency | `OutboxService` — `src/outbox/outbox.service.ts` | Deterministic idempotency keys, at-least-once relay, dead-lettering | Establishes the *pattern* this pipeline follows (deterministic identity + explicit terminal state); it is a relay, not a projection |

What was genuinely missing: a **full**, **deterministic**, **resumable**,
**report-producing** re-derivation of every V2 read model, with a guard that
keeps a partial rebuild from ever being observable as authoritative.

---

## 1. Scope boundary — what a rebuild consumes

The rebuild replays **`v2_canonical_events`**, the normalized/decoded event
log. It does **not** re-scan the chain.

This matches the position already recorded in
[`indexer-runbook.md`](./indexer-runbook.md): *"Projections are rebuildable
from raw, persisted events."* The canonical event log is produced by the
ingestion path (`CanonicalEventsService.ingest`); re-fetching it from RPC is
the indexer's job, and building a second RPC re-scan path here would duplicate
ingestion logic and create a second source of indexing truth.

Consequence: **a rebuild into a genuinely empty schema needs the canonical log
populated first.** Procedure:

1. Run the indexer against the target database until
   `GET /health/indexer` reports `projectionLag: 0` and a non-null
   `finalizedBlock` (see `indexer-runbook.md`).
2. Confirm the log: `SELECT COUNT(*), MIN("blockNumber"), MAX("blockNumber")
   FROM v2_canonical_events WHERE "chainId" = <chainId>;`
3. Only then run the rebuild.

### Projections in scope

| Projection | Tables | Events |
| ---------- | ------ | ------ |
| `v2-evidence` | `v2_project_evidence`, `v2_project_evidence_version` | `EvidenceRegistered`, `EvidenceReplaced`, `EvidenceRemoved` |
| `v2-verification` | `v2_project_verification_round`, `v2_project_participant_position` | `VerificationRoundOpened`, `PositionCommitted` |
| `v2-disputes` | `v2_project_dispute` | `DisputeRaised`, `DisputeResolved`, `DisputeExpired` |
| `v2-rewards` | `v2_project_reward_allocation`, `v2_project_reward_pool` | `RewardPoolSettled`, `RewardAllocated`, `RewardClaimed` |

The order is fixed in `src/v2/rebuild/projection-registry.ts` and is the same
on every run. The registry is composed in one file rather than contributed by
each projector module, precisely so the effective order is reviewable rather
than an accident of Nest module wiring.

### Explicitly **out** of scope

- `v2_canonical_events` itself, `v2_event_checkpoints`, `v2_event_quarantine`
  — the input, not a projection.
- `v2_indexing_anomalies` — the projector's audit log; the rebuild does not
  clear it, so anomaly history survives a rebuild.
- Legacy `src/rewards` (`reward_claims`, `reward_distributions`), the
  `IndexedEvent` indexer tables, and the realtime `projection_events` outbox —
  different pipelines, different sources. See
  [`V2_REWARD_ALLOCATION_AUDIT.md`](./V2_REWARD_ALLOCATION_AUDIT.md) §"Legacy
  paths".
- `ReorgSafeCursorService` (`src/indexer/reorg-safe-cursor.service.ts`) — see
  §7, item 2.

---

## 2. Running a rebuild

The entry point is a script, **not** an HTTP endpoint. A rebuild truncates and
re-derives every read model; exposing it over HTTP would put a destructive,
long-running, cluster-wide operation behind a request any authenticated caller
could repeat.

```bash
# Shadow rebuild — the normal case
export REBUILD_SCHEMA=truthbounty_shadow
export DATABASE_URL=postgresql://.../truthbounty_shadow
npx ts-node src/v2/rebuild/projection-rebuild.cli.ts \
  --chain-id 10 \
  --deployment-block 126000000 \
  --reset
```

| Flag | Meaning |
| ---- | ------- |
| `--chain-id` | Required. Numeric chain id (Optimism is `10`). |
| `--deployment-block` | Required. First block in scope. A **string**; never parse it into a JS number. |
| `--reset` | Clear every registered projection's tables and cursor first. Required for a from-scratch rebuild. |
| `--event-batch-size` | Events per projector per drain iteration. Default `500`. Affects speed only, never the report. |
| `--max-batches N` | Stop after N iterations and leave a resumable checkpoint. Default: drain to completion. |
| `--resume-from-block B` | Resume from a previous run's `fromBlock`. |
| `--resume-digest D` | The previous run's `inputDigest`. **Required** with `--resume-from-block`. |
| `--allow-in-place` | Acknowledge rebuilding the **live** schema. Discouraged; see §4. |

stdout carries the deterministic report; logs go to stderr. So the report
pipes cleanly:

```bash
npx ts-node src/v2/rebuild/projection-rebuild.cli.ts --chain-id 10 \
  --deployment-block 126000000 --reset > rebuild-a.json
```

---

## 3. The reconciliation report

```jsonc
{
  "anomalies": 0,               // events a projector refused and logged
  "batchesProcessed": 2,        // drain iterations (NOT part of determinism)
  "chainId": 10,
  "complete": true,             // the drain ran to exhaustion
  "deploymentBlock": "126000000",
  "eventsApplied": 184213,      // projector outcomes that wrote a row
  "eventsConsumed": 190442,     // canonical events folded into inputDigest
  "eventsSkipped": 6229,        // consumed but deliberately not written
  "fromBlock": "126000001",     // first block NOT yet folded (the resume point)
  "inputDigest": "9f2c…",       // rolling SHA-256 over consumed event identities
  "logIndex": 41,
  "perProjection": {
    "v2-disputes": {
      "anomalies": 0, "eventsApplied": 1204, "eventsConsumed": 1204,
      "eventsSkipped": 0, "rowsInTable": 1180
    }
    // …
  },
  "safeToCutover": true,        // the cutover precondition
  "toBlock": "131500207"
}
```

Every count is concrete and checkable against SQL. For example:

```sql
-- perProjection[...].rowsInTable
SELECT COUNT(*) FROM v2_project_dispute;
-- eventsApplied is in v2_projection_rebuild_runs.eventsApplied
SELECT "batchesProcessed", "eventsConsumed", "eventsApplied", "anomalies",
       "inputDigest", "safeToCutover"
FROM v2_projection_rebuild_runs ORDER BY "startedAt" DESC LIMIT 1;
```

### 3.1 What makes it deterministic

`RebuildCheckpoint` (`src/v2/rebuild/rebuild-checkpoint.ts`) contains **no
timestamp, no duration, no run id, and no host detail**. It is a pure function
of `(chainId, deploymentBlock, the ordered canonical events in range)`. All
non-deterministic material (status transitions, timings, errors) lives in the
`v2_projection_rebuild_runs` row instead.

`inputDigest` is a **left fold** of SHA-256 over
`chainId:txHash:logIndex:eventName` for every event consumed, in
`(blockNumber, logIndex)` order — the protocol's own order. Properties:

- **Order-dependent.** A reordered log yields a different digest, so a
  mis-ordered replay is detectable rather than invisible.
- **Batch-size independent.** One batch of 500 and 500 batches of 1 fold to the
  same accumulator, because each drain iteration runs every projection to
  exhaustion before the next begins, so the folded ranges are disjoint and
  ordered.
- **Resume-safe.** The accumulator is the only state carried across a
  checkpoint boundary, and it is persisted in the run row. Resuming folds the
  remainder onto the stored value and lands on the same digest as an
  uninterrupted run.

Serialisation sorts keys at every level, so two structurally equal reports
are byte-identical and can be diffed directly:

```bash
diff <(jq -S . rebuild-a.json) <(jq -S . rebuild-b.json)   # must be empty
```

### 3.2 `unclaimedEvents` — the registry drift alarm

`unclaimedEvents` counts canonical events in the drained range that **no**
registered projection claims. It is normally `0`.

A non-zero value means the registry's `eventNames` are stale: a new projector
exists in the code but not in `buildDefaultRegistry`, so a cutover would swap
in a read model that is silently missing a projection. It therefore blocks
`safeToCutover` on its own.

---

## 4. Cutover safety

**The pipeline never performs a cutover.** It has no method that swaps schemas,
renames tables, or repoints a connection. Two independent guards enforce that a
partial rebuild is never observable as authoritative:

1. **Refusal to run in place by default.** Without `REBUILD_SCHEMA` set, or
   with `--allow-in-place` absent, `rebuild()` throws before touching a single
   row. With `--allow-in-place`, it logs a warning naming the exact risk.
2. **`safeToCutover`, not `cutover`.** The report *states* whether a rebuild is
   eligible; acting on it is a separate, deliberate, documented act. The CLI
   exits `2` when `safeToCutover` is false, so a pipeline that chains the
   command fails rather than continuing.

`safeToCutover === true` requires **all** of:

- `complete` — the drain reached exhaustion, not a `maxBatches` stop;
- `anomalies === 0` — no projector refused an event;
- `unclaimedEvents === 0` — the registry accounts for the whole log.

### 4.1 The exact swap procedure (PostgreSQL)

The rebuild targets a shadow schema. The swap is a rename inside a single
transaction, so readers see either the whole old read model or the whole new
one, never a mixture.

```sql
BEGIN;

-- 0. Preconditions. Abort if any is false.
--    - the latest v2_projection_rebuild_runs row for this chain has
--      safeToCutover = true and status = 'completed'
--    - no application instance is still writing to the shadow schema
--    - a backup of the live read model exists (see docs/DISASTER_RECOVERY.md)

-- 1. Quiesce writers. The read models are written only by the projectors, so
--    stop the indexer/projector workers. Readers are unaffected and keep
--    serving from the live schema throughout.

-- 2. Capture the pre-swap row counts for the after-the-fact comparison.
CREATE TEMP TABLE rebuild_pre_counts AS
SELECT 'v2_project_dispute' AS t, COUNT(*) AS n FROM v2_project_dispute
UNION ALL SELECT 'v2_project_participant_position', COUNT(*) FROM v2_project_participant_position
UNION ALL SELECT 'v2_project_reward_allocation', COUNT(*) FROM v2_project_reward_allocation
UNION ALL SELECT 'v2_project_reward_pool',        COUNT(*) FROM v2_project_reward_pool;

-- 3. The swap. Each V2 read-model table moves in a single statement; the
--    transaction is what makes it atomic. There is no window in which a
--    reader can observe a half-rebuilt projection.
ALTER TABLE v2_project_dispute               RENAME TO v2_project_dispute_old;
ALTER TABLE truthbounty_shadow.v2_project_dispute RENAME TO v2_project_dispute;
-- … repeat for every table in scope, plus its indexes and constraints.

-- 4. Compare counts and digests against the report before committing.
--    A difference means STOP: ROLLBACK and investigate. Do not "correct" the
--    counts — a divergence between the emitted chain data and the projection
--    is a fact to understand, not a number to reconcile away.

-- 5. Only after the comparison passes:
COMMIT;

-- 6. After commit: drop the _old tables, restart the projector workers,
--    re-point the shadow connection string away from truthbounty_shadow.
```

**On a failed or rolled-back swap:** the live read model is unchanged, because
the whole swap was one transaction. Drop the shadow schema, fix, re-run the
rebuild, compare again.

**Never** "repair" a divergence by editing rows to make counts line up. The
backend may project what the chain emitted; it may not synthesise what the
chain did not.

---

## 5. Resuming

```bash
# Bounded run, keeps a resumable checkpoint
npx ts-node src/v2/rebuild/projection-rebuild.cli.ts \
  --chain-id 10 --deployment-block 126000000 --reset --max-batches 200 \
  > partial.json

# Resume from the checkpoint's own fields
npx ts-node src/v2/rebuild/projection-rebuild.cli.ts \
  --chain-id 10 --deployment-block 126000000 \
  --resume-from-block "$(jq -r .fromBlock partial.json)" \
  --resume-digest    "$(jq -r .inputDigest partial.json)" \
  > final.json
```

`--resume-digest` is mandatory alongside `--resume-from-block`: the digest is
the fold accumulator, and resuming without it would silently produce a
different final report.

A resumed run **does not** touch the projector cursors — they are exactly where
the interrupted run left them, which is the resume point.

---

## 6. Monitoring and alerting

| Signal | Source | Alert when |
| ------ | ------ | ---------- |
| Rebuild failed | `v2_projection_rebuild_runs.status = 'failed'` | any |
| Anomalies during rebuild | `v2_projection_rebuild_runs.anomalies` | `> 0` |
| Registry drift | a rebuild report with `unclaimedEvents > 0` | any |
| Digest drift | `inputDigest` differs between two runs of the same range | any |
| Row-count drift | `perProjection[].rowsInTable` differs between two runs of the same range | any |

The two drift checks are the ones worth wiring first. They turn "the projection
looks wrong" into "the projection changed for a reason the report can name".

---

## 7. Known gaps and residual risks

1. **The projectors are chain-agnostic.** `CanonicalEventQueryService.findAfter`
   filters by event name, not by `chainId`, and so do all four projectors. The
   rebuild's own event slicing *is* chain-scoped. On a single-chain deployment
   (Optimism, `chainId` 10) this is invisible; on a multi-chain deployment the
   projectors would mix chains. Pre-existing, not introduced here, and it
   affects the live incremental path identically.
2. **`ReorgSafeCursorService` is dead code that would fail at runtime.** It
   writes to `v2_indexer_cursors` and `v2_projections`, and **neither table is
   created by any migration** in `src/migrations/`. It is not registered as a
   provider anywhere, so nothing calls it. It also duplicates the role the
   canonical event log and `ProjectorCursor` already play. **Recommendation:
   delete it** rather than migrate it; the rebuild pipeline does not use it.
3. **`EventCheckpoint.lastFinalizedBlock` is never written.**
   `CanonicalEventsService.ingest` only advances `lastSafeBlock`, so
   `DisputesQueryService.calculateDataState` can never return
   `DataState.FINALIZED` and every row is reported as `SAFE` or `OBSERVED`. The
   rebuild does not touch ingestion, so a rebuilt read model inherits this. It
   is a read-model labelling bug, not a data-loss bug.
4. **Anomalies are not cleared by `--reset`.** That is intentional (the anomaly
   log is audit history), but it means `recentRuns` anomalies and
   `v2_indexing_anomalies` row counts will disagree after a reset rebuild.
5. **No integration test exercises a multi-table `ALTER TABLE … SET SCHEMA`
   swap.** The swap procedure in §4.1 is written out and reviewed, but it has
   not been executed. Treat the first cutover as a rehearsed change: run the
   whole sequence against a restored production snapshot first.
6. **A rebuild is O(canonical events) in wall time** and holds no back-pressure
   against the live indexer, because the two write to different schemas. On a
   large log, plan the window; `maxBatches` exists so it can be spread across
   several invocations.
7. **The scheduled CodeQL lane and this pipeline are unrelated** but share a
   theme: both are about a check that must actually run. See
   [`STATIC_ANALYSIS.md`](./STATIC_ANALYSIS.md).
