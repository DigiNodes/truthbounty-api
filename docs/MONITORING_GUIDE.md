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
