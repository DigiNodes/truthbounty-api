# Indexer Health & Operations Runbook

This runbook covers the indexer lag, finality, and projection health metrics exposed
by the API (V2-BE-032). It defines alert thresholds, how to interpret each signal,
and the remediation steps to follow.

> This page is intentionally sanitized: it never contains credentials, user data,
> production RPC endpoints, or secrets. For credential handling, see the deployment
> config, never this page.

## Signals measured

| Signal | Metric (Prometheus) | Health field | Meaning |
| ------ | ------------------- | ------------ | ------- |
| Observed head | `indexer_observed_head` | `observedHeadBlock` | Highest block observed from the RPC provider. |
| Safe cursor | `indexer_safe_block` | `safeBlock` | Reorg-unlikely boundary from provider finality tags. |
| Finalized cursor | `indexer_finalized_block` | `finalizedBlock` | Finality boundary (immutable state). |
| Projection head | `indexer_projection_head` | `projectionHeadBlock` | Highest block projections (derived state) have advanced to. |
| Projection lag | `indexer_projection_lag_blocks` | `projectionLag` | `observedHeadBlock - finalizedBlock` (>= 0). |
| RPC failures | `indexer_rpc_failures_total` | `rpcFailureCount` | Cumulative RPC failures (sliding window rate also computed). |
| Replay count | `indexer_replay_count_total` | `replayCount` | Cumulative event replays after reorg/retry. |
| Dead letters | `indexer_dead_letters_total` | `deadLetterCount` | Cumulative events failed past max retries. |

All values are exposed via:

- `GET /health/indexer` — sanitized JSON health snapshot (see `IndexerHealthSnapshot`).
- `GET /metrics` — Prometheus text format (Bearer-token protected via `MetricsAuthGuard`).

## Alert thresholds (defaults)

| Alert | Threshold (default) | Config key | Status |
| ----- | ------------------- | ---------- | ------ |
| Projection lag | > 150 blocks | `blockchain.projectionLagThresholdBlocks` | degraded |
| RPC failures in window | >= 20 in 5 min | `blockchain.rpcFailureLimit` / `blockchain.rpcFailureWindowMs` | degraded |
| Dead letters | > 100 | `blockchain.maxDeadLetters` | degraded |
| Missing cursors / state | head or finalized unknown | — | unhealthy |

Health status is:

- `healthy` — all signals within thresholds.
- `degraded` — one or more thresholds exceeded (service still serving).
- `unhealthy` — required state (head/finalized/RPC counters) unavailable; readiness fails closed.

## Remediation steps

1. **High projection lag**: the indexer is falling behind the finalized head.
   - Verify the RPC provider is responsive (`indexer_rpc_failures_total` and rate).
   - Increase `blockchain.blockRangePerBatch` if `getLogs` batching is throttling.
   - Restart the indexer to resume from the persisted checkpoint.
   - Escalate if lag persists beyond 30 minutes.
2. **RPC failure burst**: transient throttling or provider outage.
   - Confirm the provider is reachable and the API key/allowlist is current.
   - The retry/backoff layer absorbs transient 429s; sustained failures indicate a
     provider or network issue.
3. **Dead letters climbing**: events failing past `maxRetryAttempts`.
   - Correlate with `processingError` on the affected events.
   - Fix the processing defect, then replay the affected block range (replay will
     re-increment `indexer_replay_count_total`).
4. **Unhealthy (missing cursors)**: the indexer has not reported head/finalized state.
   - Confirm the indexer process is running and the polling loop is active.
   - Check logs for startup or RPC connectivity errors.

## Rebuild / replay impact

Projections are rebuildable from raw, persisted events. Replaying a block range is
safe: it is idempotent (unique index on `(transactionHash, logIndex, eventType)`),
and state mutations and the checkpoint commit atomically in a single transaction.
Replays are monotonic and observable via `indexer_replay_count_total`.

## Projection readiness gate (V2-BE-100)

The canonical event stream is protocol authority; the V2 read models only
reproduce it. `GET /v2/projections/readiness` reports, per projector
(`v2-evidence`, `v2-verification`, `v2-disputes`), whether that reproduction can
currently be proven, and the V2 read endpoints return `503`
(`error: "projection_not_ready"`) instead of answering from an unverifiable
projection.

Triage:

1. Read the `reasons` array in the 503 body (or on the readiness endpoint).
2. `backlog` / `cursor_missing` — the projector is behind or never ran. Let it
drain; `pendingEvents` is the exact remainder. Do not edit the cursor.
3. `quarantine_backlog` — a log from an approved contract could not be decoded.
   Inspect `v2_event_quarantine` (`reason`, `topic0`, `detail`). Register the
   corrected artifact and replay; raise
   `PROJECTION_READINESS_QUARANTINE_MAX_PENDING` only as a deliberate,
   documented decision.
4. `cursor_ahead_of_stream` — treat as an integrity incident and rebuild the
   read model from canonical events (see docs/PROJECTION_READINESS_GATE.md).
5. `evaluation_error` — a dependency or the configuration is unreadable. Check
   database connectivity/migrations and that the quarantine allowance is a
   non-negative integer. Never treat this as ready.

Full design, invariants, and rebuild procedure:
[docs/PROJECTION_READINESS_GATE.md](PROJECTION_READINESS_GATE.md).
This is separate from the in-memory `projectionLag` signal above, which reports
the legacy indexer's own head and is not derived from the canonical stream.

## Supporting interfaces

- `BlockchainStateService` (`src/blockchain/state.service.ts`) — source of truth for
  head/safe/finalized/projection cursors and the health snapshot:
  `setObservedHead`, `setSafeBlock`, `setFinalizedBlock`, `setProjectionHead`,
  `recordRpcFailure`, `recordReplay`, `recordDeadLetter`, `getIndexerHealth`.
- `IndexerMetricsService` (`src/metrics/indexer-metrics.service.ts`) — samples the
  health snapshot into Prometheus gauges/counters.
- `HealthService.getIndexerHealth` (`src/health/health.service.ts`) — web-facing,
  sanitized report at `GET /health/indexer`.
