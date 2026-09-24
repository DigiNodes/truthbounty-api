# 🛠️ TruthBounty Profiling Operations Manual

## Operator Workflow

This manual outlines standard operating procedures for backend performance monitoring, interpreting flame graphs, investigating latency spikes, and detecting regressions during releases.

---

## 1. Daily Health & Performance Inspection

1. Open the Profiling Dashboard at `http://localhost:3000/profiler/dashboard`.
2. Inspect the **Average Latency**, **p95 Latency**, and **p99 Latency** cards.
3. Check the **Slowest Endpoints** table to identify endpoints exceeding SLA targets (> 200ms).
4. Review the **Database Query Bottlenecks** table for queries taking longer than 100ms.

---

## 2. Investigating Latency Spikes with Flame Graphs

When an endpoint experiences elevated latency:

1. Fetch recent slow traces for the endpoint:
   ```bash
   GET /profiler/traces?route=/claims&minDurationMs=200
   ```
2. Retrieve the trace ID from the response.
3. Fetch the flame graph structure:
   ```bash
   GET /profiler/traces/{traceId}/flamegraph
   ```
4. Examine `value` and `percentage` fields of child nodes to isolate whether time is spent in:
   - Database queries (`category: "db"`)
   - Redis operations (`category: "redis"`)
   - External RPC calls (`category: "blockchain"`)
   - Webhook delivery (`category: "notification"`)

---

## 3. Deployment Baseline & Regression Testing

Before releasing a new backend version:

1. Take a baseline snapshot of the current release:
   ```bash
   POST /profiler/snapshots
   Body: { "name": "release-v1.4.0-baseline" }
   ```
2. Deploy the target release candidate to staging/production.
3. Run performance test load or allow production traffic to collect traces.
4. Take a target snapshot:
   ```bash
   POST /profiler/snapshots
   Body: { "name": "release-v1.5.0-candidate" }
   ```
5. Execute automated regression detection:
   ```bash
   GET /profiler/regressions?baselineId={baselineId}&targetId={targetId}&thresholdPercent=20
   ```
6. If `status` is `"regressions_detected"`, review the `regressions` array for components with >20% latency degradation.

---

## 4. Tuning Production Sampling Strategies

| Strategy | Description | Recommended Environment |
| :--- | :--- | :--- |
| `always-sample` (fixed-rate 1.0) | Captures 100% of request traces | Local Development, Staging |
| `fixed-rate` (0.05 – 0.20) | Captures fixed percentage of requests | Production (low-to-medium traffic) |
| `adaptive` | Dynamically throttles sampling if CPU exceeds 80% | Production (high traffic / auto-scaling) |
| `header-based` | Samples on-demand via HTTP header `x-profile-request: true` | Production Debugging |
