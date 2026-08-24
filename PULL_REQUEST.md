# Pull Request: BE-036 Implement Backend Performance Profiling Service

## 📚 Overview
This PR implements the **Backend Performance Profiling Service** (BE-036) for the TruthBounty backend. It continuously measures application latency, profiles database queries, Redis operations, blockchain RPC calls, queue processing, notification delivery, collects process resource utilization metrics (CPU/Memory), builds execution timelines and flame graphs, supports production-safe adaptive sampling, and automates performance regression detection across historical baseline snapshots.

---

## 🎯 Objectives & Acceptance Criteria Met
- [x] **Request Profiling**: HTTP request duration, route path, method, status codes, payload sizes, memory/CPU deltas.
- [x] **Database Profiling**: Query timing, entity attribution, slow query flagging (> 100ms default threshold), parameter sanitization.
- [x] **Redis Profiling**: Command timing (GET, SET, DEL), key patterns, hit/miss metrics.
- [x] **Blockchain RPC Profiling**: Provider call latency for Optimism, Ethereum, and Soroban/Stellar RPC methods.
- [x] **Queue & Job Profiling**: BullMQ background worker job execution duration and status tracking.
- [x] **Notification Profiling**: Webhook dispatch and notification delivery timing.
- [x] **Resource Metrics Collection**: Periodic process memory (heap/rss/arrayBuffers) and CPU usage percentage sampling.
- [x] **Flame Graphs & Timelines**: Hierarchical call tree visualization with time percentage allocations.
- [x] **Configurable Production-Safe Sampling**: `fixed-rate`, `adaptive` (load-based scaling), `route-based`, and `header-based` (`x-profile-request`) overrides.
- [x] **Historical Comparisons & Regression Detection**: Baseline snapshot comparison and automated regression detection flagging components with > 20% latency degradation.
- [x] **Dashboards & REST Endpoints**: Operational HTML dashboard and REST endpoints under `/profiler/*`.
- [x] **Comprehensive Documentation**: Added Performance Guide, Operations Manual, Backend Documentation, and Monitoring Guide.
- [x] **Test Coverage (90%+)**: Unit tests, controller tests, sampling strategy validation, overhead benchmarking (< 0.1ms overhead per trace).

---

## 🧩 Technical Changes Included

### 1. Core Profiling Engine (`src/profiler`)
- `src/profiler/interfaces/profiler.interface.ts`: Data structures for `Span`, `Trace`, `FlameGraphNode`, `LatencyDistribution`, `BottleneckReport`, `SamplingConfig`, `HistoricalSnapshot`, and `RegressionReport`.
- `src/profiler/profiler.service.ts`: Node.js `AsyncLocalStorage`-driven context tracing, circular trace buffer (up to 5,000 traces), percentiles calculator (p50..p99), flame graph generator, historical baseline comparisons, and regression algorithms.
- `src/profiler/profiler.interceptor.ts`: Global NestJS HTTP request interceptor.

### 2. Sub-Profilers (`src/profiler/sub-profilers/`)
- `database-profiler.ts`: TypeORM / Prisma query execution wrapper.
- `redis-profiler.ts`: Redis command latency wrapper.
- `blockchain-profiler.ts`: Ethers.js & Soroban/Stellar RPC call wrapper.
- `job-profiler.ts`: BullMQ background job worker wrapper.
- `notification-profiler.ts`: Webhook delivery wrapper.

### 3. REST Controller & Dashboard (`src/profiler/profiler.controller.ts`)
- `GET /profiler/summary`: High-level summary of profiling status and system overview.
- `GET /profiler/metrics`: Latency distribution percentiles (p50..p99) and resource metrics.
- `GET /profiler/traces`: Filterable execution traces.
- `GET /profiler/traces/:id`: Detailed trace breakdown with sub-spans.
- `GET /profiler/traces/:id/flamegraph`: Flame graph tree node structure.
- `GET /profiler/bottlenecks`: Bottleneck report (slow queries, endpoints, Redis, RPC, CPU hotspots).
- `GET /profiler/snapshots`: List or take historical performance snapshots.
- `GET /profiler/compare`: Delta comparison between snapshot baselines.
- `GET /profiler/regressions`: Performance regression detection report.
- `GET /profiler/sampling` & `PUT /profiler/sampling`: View/update dynamic sampling rates & strategies.
- `GET /profiler/dashboard`: Interactive HTML/JSON operational dashboard.

### 4. NestJS Application Integration
- `src/profiler/profiler.module.ts`: NestJS module encapsulating Profiler providers and controllers.
- `src/app.module.ts`: Registered `ProfilerModule` and global `ProfilerInterceptor`.

### 5. Documentation (`docs/`)
- `docs/PERFORMANCE_GUIDE.md`: Performance guide & backend profiling usage.
- `docs/OPERATIONS_MANUAL.md`: Operating procedures, interpreting flame graphs, baseline workflows.
- `docs/BACKEND_DOCUMENTATION.md`: Architecture diagrams, data schemas, AsyncLocalStorage details.
- `docs/MONITORING_GUIDE.md`: Integration with BE-011 Metrics Service, BE-027 API Analytics, and BE-030 Health Diagnostics.

---

## 🧪 Testing & Verification

Comprehensive Jest test suite added in `src/profiler/tests/`:
- `profiler.service.spec.ts`: Trace lifecycles, sub-span tracking, percentiles calculation, flame graphs, snapshots, regression algorithms.
- `profiler.controller.spec.ts`: Controller REST endpoints and input validation.
- `sampling-validation.spec.ts`: Fixed-rate, adaptive CPU scaling, header override (`x-profile-request`), and route-specific sampling.
- `performance-overhead.spec.ts`: Benchmarking verifying profiling overhead is strictly < 0.1ms per operation.
- `sub-profilers.spec.ts`: Database, Redis, Blockchain, Queue, and Notification sub-profilers testing.

---

## 🏷️ Labels
`backend` `performance` `monitoring` `complexity-high` `stellar-wave`
