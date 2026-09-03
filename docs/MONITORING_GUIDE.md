# 📊 TruthBounty Monitoring & Metrics Integration Guide

## Overview

The Profiling Service integrates seamlessly with existing observability modules across the TruthBounty backend:
- **BE-011 Metrics Service** (`src/metrics`): Prometheus gauge & histogram collection.
- **BE-027 API Usage Analytics** (`src/analytics`): Operational analytics and request statistics.
- **BE-030 Health Diagnostics** (`src/health`): Liveness, readiness, and resource diagnostics.
- **BE-016 Protocol Health & System Monitoring** (`src/health` + `src/metrics`): infrastructure, queue, and blockchain gauges described below.

---

## Metric Correlators

The Profiler captures timing and resource metrics that complement Prometheus counters:

```
[Prometheus Metrics Service (BE-011)] ──→ Counter: http_requests_total
                                         ──→ Histogram: http_request_duration_seconds
                                         ──→ Gauge: process_memory_usage_bytes{type}
                                         ──→ Gauge: process_cpu_usage_microseconds{mode}
                                         ──→ Gauge: queue_jobs_total{queue,state}
                                         ──→ Gauge: blockchain_last_indexed_block
                                         ──→ Gauge: blockchain_indexing_lag_blocks

[Health Diagnostics (BE-030)]        ──→ Liveness / Readiness / Memory Diagnostics

[Performance Profiler (BE-036)]      ──→ Sub-span execution flame graphs
                                         ──→ Slow query parameter tracking
                                         ──→ Adaptive CPU load sampling
                                         ──→ Historical regression detection
```

---

## Prometheus & Grafana Configuration

The `/profiler/metrics` endpoint provides JSON latency percentiles which can be exported to Grafana dashboards or converted to Prometheus metrics.

The `/metrics` endpoint (`src/metrics`) exposes standard Prometheus text format directly, including the infrastructure/queue/blockchain gauges added under BE-016 (see below) — these can be scraped by Prometheus and wired into Grafana panels or Alertmanager rules without any additional conversion step.

### Key Monitoring Thresholds
- **Target Average API Response Time**: `< 100ms`
- **Target p95 API Latency**: `< 250ms`
- **Target p99 API Latency**: `< 500ms`
- **Max Slow Query Threshold**: `100ms`
- **Max Profiling Overhead**: `< 1ms`

---

 feat/be-016-monitoring-api
## BE-016: Protocol Health & System Monitoring API

BE-016 asked for a broad (~5-6 day) monitoring surface spanning health endpoints,
infrastructure/database/blockchain/queue/performance metrics, five external
alerting integrations, historical time-series reporting, and full
documentation. This section is an honest account of what's actually been
implemented against that scope, so nobody has to re-derive it from the diff.

### What was already in place before this issue

- **Health endpoints** (`src/health`): `/health`, `/health/live`,
  `/health/ready`, `/health/startup`, `/health/dependencies` — all already
  implemented, with proper healthy/degraded/unhealthy semantics and
  per-dependency response times.
- **Service health checks**: database (PostgreSQL via TypeORM), Redis,
  the BullMQ jobs queue, notifications, IPFS, and blockchain state were
  already checked as part of `/health` and `/health/ready`.
- **Prometheus integration**: `src/metrics` already exposed
  `http_requests_total` and `http_request_duration_seconds` via
  `prom-client`, scraped through `/metrics`.
- **Performance profiling** (`src/profiler`): flame graphs, slow-query
  tracking, CPU sampling, and historical regression detection already
  existed independently of this issue.
- **API usage analytics** (`src/analytics`): already provided operational
  request statistics.

### What this pass added

- **Infrastructure metrics as scrapable gauges**: `process_memory_usage_bytes{type}`
  (rss/heapTotal/heapUsed/external) and `process_cpu_usage_microseconds{mode}`
  (user/system). The underlying data (`process.memoryUsage()` /
  `process.cpuUsage()`) was already being computed inside `HealthService`'s
  diagnostics for the `/health` JSON response; it just wasn't exposed as
  Prometheus gauges anyone could alert on. Now both.
- **Queue monitoring as a scrapable gauge**: `queue_jobs_total{queue,state}`,
  populated from the same `Queue.getJobCounts(...)` call the existing
  `/health/ready` check already made — again, reusing verified data rather
  than adding a second, parallel queue-inspection path.
- **Blockchain indexing metrics**: `blockchain_last_indexed_block` and
  `blockchain_indexing_lag_blocks`, sourced from `BlockchainStateService`.
  Note: this codebase's `ChainState` type has no notion of the live chain
  head block (only `lastProcessedBlock`), so `blockchain_indexing_lag_blocks`
  can only be computed when a caller explicitly supplies a chain-head value
  — it is intentionally omitted rather than fabricated when unavailable.
- **Fixed a pre-existing bug** in `HealthService.getHealth()`: the call to
  `collectDiagnostics()` (an `async` method) was never `await`ed, meaning
  the `/health` response's `diagnostics` field was silently serializing a
  `Promise` object instead of real data. Found while wiring the new gauges
  into that same method; fixed since it directly affects the diagnostics
  this issue is about.

### What was intentionally not attempted, and why

This issue's full technical scope is large enough that most of it is a
genuinely separate, multi-day effort rather than something to bolt on here
without real verification. Left undone, honestly:

- **Disk usage, network traffic, process count, container status,
  Kubernetes-awareness**: no OS-level or container-runtime probe exists
  anywhere in this codebase to build on, and fabricating these without a
  real environment to verify against would produce metrics nobody could
  trust.
- **Database monitoring beyond connectivity/latency/migrations/pool stats**
  (slow query aggregation beyond what the profiler already does,
  replication status, storage utilisation): would need direct
  `pg_stat_*` instrumentation against a real multi-node Postgres setup to
  verify correctly, not available here.
- **Grafana dashboard JSON, Alertmanager rule definitions, OpenTelemetry
  tracing, Datadog integration**: these are downstream consumers of the
  Prometheus metrics this pass added, but writing dashboard/alert configs
  without a real Grafana/Alertmanager instance to validate them against
  would be unverified boilerplate, not a working integration.
- **Historical metrics with configurable reporting periods**: would need a
  time-series storage decision (a dedicated store, or Prometheus's own
  retention/query API) that's a design decision for the team, not
  something to bolt on unilaterally.
- **Separate health checks for Governance Service, Analytics Service,
  AI Assistant, and Background Workers as named dependencies**: these
  modules exist in the codebase but don't currently expose an obvious
  single health signal the way database/redis/queue do; adding checks
  against the wrong signal would be worse than no check at all.

Recommendation: treat this as the "make the infra/queue/blockchain data
that already exists inside HealthService actually alertable" slice of
BE-016, and track the remaining sections above as their own,
appropriately-scoped follow-up issues rather than one epic.
## Indexer Health & Projection Metrics (V2-BE-032)

The API exposes indexer lag, finality, and projection health signals for the
Optimism/EVM V2 pipeline, backed by the live `BlockchainStateService`:

- `indexer_observed_head` — highest block observed from the RPC provider.
- `indexer_safe_block` — safe cursor (reorg-unlikely).
- `indexer_finalized_block` — finalized cursor (finality boundary).
- `indexer_projection_head` — highest block projections have advanced to.
- `indexer_projection_lag_blocks` — projection lag (`observedHead - finalized`).
- `indexer_rpc_failures_total` — cumulative RPC failures.
- `indexer_replay_count_total` — cumulative event replays after reorg/retry.
- `indexer_dead_letters_total` — cumulative dead-lettered events.

Sanitized JSON is available at `GET /health/indexer` with `healthy | degraded |
unhealthy` status. Alert thresholds and remediation steps are documented in
[docs/indexer-runbook.md](indexer-runbook.md). Exposed values never include
credentials, user data, or live RPC endpoints.

 main
