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
- `GET /v2/projections/freshness` — per-projector freshness and finality
  metadata (`v2-evidence`, `v2-verification`, `v2-disputes`, plus any extra
  persisted projector cursors). `GET /v2/projections/freshness/:projectorName`
  returns a single projector. Public read-only GET surface (no auth required,
  no mutation handlers); failures are bounded and fail closed (see
  `ProjectionFreshness` in `src/v2/projection/`).

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

## Projection freshness fields (V2)

Each entry in `GET /v2/projections/freshness` reports:

| Field | Meaning |
| ----- | ------- |
| `projectorName` | Cursor name, e.g. `v2-evidence`. |
| `indexedBlock` | Highest canonical-event block applied by the projector (`null` if never ran). |
| `finalizedHeight` | Highest finalized block known — DB checkpoints primary, indexer snapshot fallback (`null` + `finality-unavailable` when unknown). |
| `safeHeight` | Highest safe block known, same sourcing as finalized. |
| `observedHead` | Live observed head from the indexer snapshot (`null` when unavailable). |
| `headDistance` | `observedHead - indexedBlock` as a bigint-safe string (`null` when either side unknown). |
| `lastSuccess` | ISO timestamp of the cursor's last advance (`null` if never ran). |
| `status` | `healthy` / `degraded` / `unhealthy` (unhealthy wins over degraded). |
| `degradedReason` | Semicolon-joined machine-readable reasons (`cursor-missing`, `finality-unavailable`, `indexer-degraded`, `indexer-unhealthy`, `indexer-health-unavailable`, …) or `null` when healthy. |
| `dataState` | `observed` / `safe` / `finalized` for the projector's `indexedBlock`. |

Notes:

- The endpoints are derived read models only: they never settle protocol
  state, sign transactions, or compute verdicts.
- `lastFinalizedBlock` in `v2_event_checkpoints` is advanced by ingestion;
  until a checkpoint row exists, heights fall back to the live snapshot and
  the report names the gap via `degradedReason` instead of guessing.
- Block heights are strings so values beyond `Number.MAX_SAFE_INTEGER` keep
  full precision; cross-driver (PostgreSQL/SQLite) normalization is applied.

## Supporting interfaces

- `BlockchainStateService` (`src/blockchain/state.service.ts`) — source of truth for
  head/safe/finalized/projection cursors and the health snapshot:
  `setObservedHead`, `setSafeBlock`, `setFinalizedBlock`, `setProjectionHead`,
  `recordRpcFailure`, `recordReplay`, `recordDeadLetter`, `getIndexerHealth`.
- `IndexerMetricsService` (`src/metrics/indexer-metrics.service.ts`) — samples the
  health snapshot into Prometheus gauges/counters.
- `HealthService.getIndexerHealth` (`src/health/health.service.ts`) — web-facing,
  sanitized report at `GET /health/indexer`.
