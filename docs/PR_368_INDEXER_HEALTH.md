# PR: #368 V2-BE-032 — Indexer Lag, Finality & Projection Health Metrics

## Summary

Adds live indexer health observability to the V2 Optimism/EVM backend: observed
head, safe/finalized cursors, projection lag, RPC failures, replay count, and
dead letters — exposed as sanitized health JSON and Prometheus metrics, with alert
thresholds and a runbook link (no credentials, user data, or live RPC endpoints).

## Architecture

- **Source of truth**: `BlockchainStateService` (`src/blockchain/state.service.ts`)
  is the live indexer state path (wired via `BlockchainModule`). It now tracks
  observed head, safe/finalized cursors, projection head, RPC failures (sliding
  window + cumulative counter), replays, and dead letters, and derives projection
  lag (`observedHead - finalized`).
- **Collection points**: `EventIndexingService.processBlock` records observed head,
  projection head, replays, and (on failure) RPC failures. `BlockchainIndexerService`
  advances the projection head as checkpoints commit and records replays on rollback.
- **Metrics**: `IndexerMetricsService` (`src/metrics/indexer-metrics.service.ts`)
  samples the health snapshot into Prometheus gauges/counters (`indexer_*`), served
  at the existing Bearer-protected `/metrics` endpoint.
- **Health endpoint**: `GET /health/indexer` returns a sanitized `IndexerHealthSnapshot`.

## Reused / replaced / deprecated paths

- **Reused**: `MetricsService` + `prom-client` registry, `HealthController`/`HealthService`,
  `BlockchainStateService`, `MetricsAuthGuard` (authorization on `/metrics`).
- **Replaced**: the dormant `EventIndexerService` (`src/indexer/`) is *not* wired into
  the app; metrics are based on the live `BlockchainStateService` path per audit.
- **Deprecated (identified, out of scope)**: none removed; noted for follow-up.

## Security

- No secrets, production credentials, dummy addresses, floating-point token
  accounting, or Stellar/Freighter dependencies added.
- Health/metrics output is sanitized — never includes RPC URLs, credentials, or
  user data (covered by unit tests).
- Behavior fails closed: missing head/finalized/RPC state ⇒ `unhealthy`; readiness
  check degrades when indexer health is unhealthy.
- No backend-authoritative protocol mutation is introduced.

## Migration / rebuild impact

- **None**: all new state is in-memory (`ChainState`); no schema or migration change.
- Projections remain rebuildable from raw persisted events; replay remains
  idempotent (unique index on `(transactionHash, logIndex, eventType)`) and state +
  checkpoint commit atomically in a single transaction.

## Observability

Prometheus: `indexer_observed_head`, `indexer_safe_block`, `indexer_finalized_block`,
`indexer_projection_head`, `indexer_projection_lag_blocks`, `indexer_rpc_failures_total`,
`indexer_replay_count_total`, `indexer_dead_letters_total`.
Health JSON: `GET /health/indexer`. See `docs/indexer-runbook.md` for thresholds + steps.

## Evidence (commands)

- `npm run build` — no new errors; **baseline failures only** (see Residual risks).
- `npx jest src/blockchain/state.service.spec.ts src/metrics/tests/indexer-metrics.service.spec.ts`
  → pass (new indexer-health coverage).
- `npx jest src/blockchain/*indexer*spec.ts src/blockchain/blockchain-replay.spec.ts
  src/blockchain/blockchain-reorg.integration.spec.ts` → **17 passed** (replay/regression + integration; constructor change verified).
- `npx eslint <changed files>` — prettier normalized; residual `require-await` /
  `no-unsafe-*` are baseline (see Residual risks).

## Acceptance-criteria mapping

| Criterion | Evidence |
| --------- | -------- |
| Measure head, safe/finalized, lag, RPC failures, replay, dead letters | `BlockchainStateService` fields/methods; unit tests |
| Sanitized health endpoint + Prometheus metrics | `GET /health/indexer`; `IndexerMetricsService` at `/metrics` |
| Alert thresholds + runbook, no leak | `docs/indexer-runbook.md`; sanitization tests |
| No protocol mutation | read/record only |
| Tests: success/failure/retry-replay/auth | state, metrics, replay, integration specs; `MetricsAuthGuard` |
| Docs/schemas/migrations/artifacts current | runbook + `MONITORING_GUIDE.md`; no migration needed |
| Evidence mapped | this document |

## Residual risks / baseline failures

- **Pre-existing build errors (baseline, not from this PR)**: `websocket.gateway.ts`,
  `admin/protocol/protocol-admin.controller.ts`, and `health.service.ts` `collectDiagnostics()`
  missing `await` (TS2739) — among others. These exist on `main` and block a full
  `npm run build`; reported separately.
- **Baseline lint**: the repo does not pass `npm run lint` on `main` (CRLF/quote
  formatting + `no-unsafe-*`/`require-await` across existing files). My changed files
  were normalized with prettier to match project config.
- Dependencies V2-BE-010 / V2-BE-019 / V2-BE-020 are **noted as required but unverified**
  for this scope.
