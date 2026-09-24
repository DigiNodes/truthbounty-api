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

## V2-BE-125 — Adaptive Historical Backfill

This section documents the behaviour changes introduced by V2-BE-125. All changes
are observable and fail-closed; no protocol state is mutated by the indexer.

### Adaptive range halving (fix 1.1)

When a provider rejects a `getLogs` range as too large (error codes: `-32005`,
`Log response size exceeded`, `query returned more than`, etc.) the indexer
automatically halves the requested block range and retries. It keeps halving until
the request succeeds or the range reaches `MIN_BATCH_SIZE_FLOOR` (default: 1 block).

Each halving step is logged at `WARN` level. The effective batch size is permanently
reduced for the remainder of the current backfill pass, then reset at the start of
the next `backfillFromBlock` call.

**Action required**: if you see repeated halving warnings, lower `BLOCK_RANGE_PER_BATCH`
to a value the provider accepts without triggering the limit, which avoids the
overhead of repeated retries.

### High-throughput adaptive backfill mode (fix 1.2)

When `POST /indexer/backfill` is called and the gap between the requested start block
and the current finalized block exceeds `ADAPTIVE_FILL_THRESHOLD_BLOCKS` (default:
10 000), the indexer enters adaptive backfill mode. In this mode batches are issued
immediately, without waiting for `POLLING_INTERVAL_MS`, until the gap is closed.

A structured JSON log event is emitted when the mode is entered:

```json
{ "event": "adaptive_backfill_mode_entered", "contractAddress": "0x...",
  "startBlock": 1000000, "finalizedBlock": 1200000, "gapBlocks": 200000 }
```

And when it exits:

```json
{ "event": "adaptive_backfill_mode_exited", "contractAddress": "0x...",
  "finalCursor": 1200001, "finalizedBlock": 1200000 }
```

### Finality-capped cursors (fix 1.3)

The `endBlock` for every batch is now capped at the provider's reported finalized
block (`eth_getBlockByNumber("finalized")`), not at `currentBlockNumber -
confirmationsRequired`. This means the cursor never advances past canonical finality,
preventing over-indexing on a head that may be rolled back.

If the provider call fails, the service falls back to `currentBlockNumber -
confirmationsRequired` (fail-closed, conservative behaviour).

### Dead-letter health integration (fix 1.4)

Events that fail processing past `MAX_RETRY_ATTEMPTS` are now permanently set to
`dead_letter` status in `indexing_state` and `stateService.recordDeadLetter(1)` is
called. The `deadLetterCount` field in `GET /health/indexer` and the
`indexer_dead_letters_total` Prometheus counter therefore reflect these events.

The existing `Dead letters` alert threshold (`blockchain.maxDeadLetters`, default 100)
now fires correctly when events are exhausted. See [Remediation step 3](#remediation-steps)
for handling dead letters.

### Atomic batch commits (fix 1.5)

All event rows for a batch and the `lastProcessedBlockNumber` checkpoint update are
now written inside a **single database transaction**. A restart mid-batch will resume
from the last successfully committed checkpoint — no duplicate delivery and no
skipped blocks.

### Deployment-block validation on backfill (fix 1.6)

`POST /indexer/backfill` now validates that the requested `blockNumber` is greater
than or equal to the `deploymentBlock` recorded in `v2_contract_artifacts` for the
given `contractAddress` and `chainId`. Requests that predate the contract's on-chain
genesis are rejected with `HTTP 400` and an explanatory message:

```
blockNumber 99999 predates the canonical deployment block 100000 for contract
0x... on chain 10. Backfill must start at or after the contract's deployment block.
```

If no approved artifact exists for the contract, or if `deploymentBlock` is `NULL`
(rows predating migration `1790000000000`), the validation is skipped and the
backfill proceeds.

**Migration required**: run `npm run migration:run` to apply
`1790000000000-AddDeploymentBlockToContractArtifact` before deploying this change.

### Immediate finalization of historical blocks (fix 1.7)

Events whose `blockNumber` is less than or equal to the provider's current finalized
block are immediately stored with `isFinalized = true`, bypassing the
`CONFIRMATIONS_REQUIRED` check. This is correct because finalized historical blocks
are canonical and cannot reorg.

Live-tip events (above the finalized block) continue to use the confirmation-count
threshold as before.

### Paginated reorg reconciliation (fix 1.8)

`reconcileReorgs` now loads finalized events in pages of 1 000 rows at a time
(hardcoded; controlled by `reorgPageSize` in `EventIndexerService`). This prevents
OOM crashes on nodes with large event histories.

### Environment variables (new in V2-BE-125)

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `MIN_BATCH_SIZE_FLOOR` | `1` | Minimum block range the adaptive halving logic will try before giving up. |
| `ADAPTIVE_FILL_THRESHOLD_BLOCKS` | `10000` | Gap above which `backfillFromBlock` enters high-throughput mode. |

---

## Supporting interfaces

- `BlockchainStateService` (`src/blockchain/state.service.ts`) — source of truth for
  head/safe/finalized/projection cursors and the health snapshot:
  `setObservedHead`, `setSafeBlock`, `setFinalizedBlock`, `setProjectionHead`,
  `recordRpcFailure`, `recordReplay`, `recordDeadLetter`, `getIndexerHealth`.
- `IndexerMetricsService` (`src/metrics/indexer-metrics.service.ts`) — samples the
  health snapshot into Prometheus gauges/counters.
- `HealthService.getIndexerHealth` (`src/health/health.service.ts`) — web-facing,
  sanitized report at `GET /health/indexer`.
