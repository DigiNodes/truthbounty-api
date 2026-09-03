# ⚡ TruthBounty Performance & Profiling Guide

## Overview

The **Backend Performance Profiling Service** continuously measures API response times, profiles database queries, Redis cache operations, blockchain RPC calls, BullMQ background jobs, and notification delivery across the TruthBounty backend.

It is designed for production-safe, low-overhead observability (< 0.1ms overhead per operation).

---

## Technical Features

1. **HTTP Request Profiling**: Measures request duration, status code distribution, payload sizes, memory & CPU deltas per route.
2. **Database Query Profiling**: Flags slow queries exceeding configurable threshold (`100ms` default), sanitizes sensitive SQL parameters, tracks query execution counts.
3. **Redis & Cache Profiling**: Tracks command latency (GET, SET, DEL), key patterns, and cache hit/miss statistics.
4. **Blockchain RPC Profiling**: Measures execution times for Optimism, Ethereum, and Soroban/Stellar RPC invocations.
5. **Queue & Job Profiling**: Tracks BullMQ worker execution timelines and error rates.
6. **Notification Delivery**: Measures external webhook dispatch latencies.
7. **Flame Graphs & Timeline Spans**: Hierarchical call tree visualization for root transactions and nested sub-operations.
8. **Configurable Sampling**: Fixed-rate, adaptive (load-based), header-based override (`x-profile-request`), and route-specific sampling.
9. **Historical Comparison & Regression Detection**: Statistical detection of performance degradation between deployment baselines.

---

## Quick Reference API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/profiler/summary` | GET | Profiler status, total traces, error rate, resource metrics |
| `/profiler/metrics` | GET | Latency distribution percentiles (p50, p75, p90, p95, p99) |
| `/profiler/traces` | GET | Filterable execution traces (by route, method, slow queries) |
| `/profiler/traces/:id` | GET | Detailed trace breakdown with sub-spans |
| `/profiler/traces/:id/flamegraph` | GET | Hierarchical flame graph data structure for trace |
| `/profiler/bottlenecks` | GET | Bottleneck report (slow queries, endpoints, Redis, RPC, CPU hotspots) |
| `/profiler/snapshots` | GET/POST | List or create historical baseline snapshots |
| `/profiler/compare` | GET | Delta comparison between two historical snapshots |
| `/profiler/regressions` | GET | Detect performance degradation between snapshots |
| `/profiler/sampling` | GET/PUT | View or dynamically adjust sampling rate and strategy |
| `/profiler/dashboard` | GET | HTML/JSON interactive operational dashboard |

---

## Production Sampling Configuration

To prevent high resource overhead in high-throughput environments, configure sampling via environment variables or dynamic API:

```json
{
  "enabled": true,
  "strategy": "adaptive",
  "defaultSampleRate": 0.1,
  "slowQueryThresholdMs": 100,
  "targetCpuThresholdPercent": 80,
  "headerOverrideKey": "x-profile-request"
}
```

### Forcing Request Profiling via Header
Engineers can force 100% sampling for specific debugging HTTP requests using the header:
```bash
curl -H "x-profile-request: true" http://localhost:3000/api/claims
```
