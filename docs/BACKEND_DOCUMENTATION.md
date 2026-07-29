# 🏗️ TruthBounty Backend Documentation & Profiling Architecture

## System Architecture

The TruthBounty Backend Profiling Architecture relies on Node.js `AsyncLocalStorage` and high-resolution monotonic time (`process.hrtime.bigint()`) to track request context asynchronously across multi-tier dependencies.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PROFILER INTERCEPTOR                            │
│                     (Incoming HTTP Request)                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          PROFILER SERVICE                              │
│              - AsyncLocalStorage Context Management                    │
│              - Bounded Circular Trace Buffer (Max 5,000)                │
│              - Resource Metrics Collector (CPU/Memory)                 │
└───────┬───────────────────────────┬────────────────────────────┬───────┘
        │                           │                            │
        ▼                           ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│  Database    │             │    Redis     │             │  Blockchain  │
│  Profiler    │             │   Profiler   │             │   Profiler   │
│ (TypeORM/    │             │  (Cache Ops  │             │ (Ethers/     │
│  Prisma)     │             │   Hit/Miss)  │             │  Soroban)    │
└──────────────┘             └──────────────┘             └──────────────┘
        │                           │                            │
        └───────────────────────────┴────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     REST API & DASHBOARD (/profiler)                   │
│  - Bottleneck Aggregator    - Flame Graph Generator                    │
│  - Percentiles (p50..p99)   - Regression Detection Algorithm           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### Trace Structure (`Trace`)
```typescript
interface Trace {
  id: string;
  name: string;
  category: 'http' | 'db' | 'redis' | 'blockchain' | 'queue' | 'notification' | 'system';
  route?: string;
  method?: string;
  statusCode?: number;
  startTimeMs: number;
  durationMs: number;
  rootSpan: Span;
  spans: Span[];
  slowQueryCount: number;
  memoryDeltaMb: number;
  cpuDeltaUs: { user: number; system: number };
  timestamp: string;
  sampled: boolean;
}
```

### Flame Graph Node (`FlameGraphNode`)
```typescript
interface FlameGraphNode {
  name: string;
  value: number; // Duration in ms
  durationMs: number;
  category: SpanCategory;
  children: FlameGraphNode[];
  percentage: number; // Percentage of total trace execution time
}
```

---

## Sub-Profilers Usage

- **DatabaseProfiler**: Wrap complex queries or ORM calls with `dbProfiler.profileQuery(query, entity, fn)`.
- **RedisProfiler**: Wrap cache queries with `redisProfiler.profileOperation(command, key, fn)`.
- **BlockchainProfiler**: Wrap smart contract calls with `blockchainProfiler.profileRpcCall(method, network, fn)`.
- **JobProfiler**: Wrap background workers with `jobProfiler.profileJob(jobName, queueName, fn)`.
- **NotificationProfiler**: Wrap webhook dispatches with `notificationProfiler.profileNotification(type, target, fn)`.
