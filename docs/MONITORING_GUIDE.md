# 📊 TruthBounty Monitoring & Metrics Integration Guide

## Overview

The Profiling Service integrates seamlessly with existing observability modules across the TruthBounty backend:
- **BE-011 Metrics Service** (`src/metrics`): Prometheus gauge & histogram collection.
- **BE-027 API Usage Analytics** (`src/analytics`): Operational analytics and request statistics.
- **BE-030 Health Diagnostics** (`src/health`): Liveness, readiness, and resource diagnostics.

---

## Metric Correlators

The Profiler captures timing and resource metrics that complement Prometheus counters:

```
[Prometheus Metrics Service (BE-011)] ──→ Counter: http_requests_total
                                         ──→ Histogram: http_request_duration_seconds

[Health Diagnostics (BE-030)]        ──→ Liveness / Readiness / Memory Diagnostics

[Performance Profiler (BE-036)]      ──→ Sub-span execution flame graphs
                                         ──→ Slow query parameter tracking
                                         ──→ Adaptive CPU load sampling
                                         ──→ Historical regression detection
```

---

## Prometheus & Grafana Configuration

The `/profiler/metrics` endpoint provides JSON latency percentiles which can be exported to Grafana dashboards or converted to Prometheus metrics.

### Key Monitoring Thresholds
- **Target Average API Response Time**: `< 100ms`
- **Target p95 API Latency**: `< 250ms`
- **Target p99 API Latency**: `< 500ms`
- **Max Slow Query Threshold**: `100ms`
- **Max Profiling Overhead**: `< 1ms`

---

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

