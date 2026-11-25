# Shared Abuse Signal Store

**Issue:** PREWAVE-BE-111 (#812)  
**Status:** Implemented  
**Dependencies:** PostgreSQL, TypeORM

## Overview

The shared abuse signal store provides durable, multi-replica-consistent storage for abuse detection windows, decisions, and actions. It replaces the process-local in-memory store for deployments that enable enforcement, ensuring that:

1. **Multiple replicas converge** on the same window aggregates, decisions, and enforcement actions
2. **Actions survive restarts** and expired actions stop enforcement deterministically
3. **Atomic operations** prevent lost updates under concurrent load
4. **Bounded collections** prevent unbounded memory growth
5. **Enforcement fails closed** when the store is unavailable or misconfigured

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                    AbuseSignalsModule                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │          AbuseSignalsStartupValidator               │  │
│  │  • Validates enforcement + store binding            │  │
│  │  • Aborts startup if unsafe combination detected    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              ABUSE_SIGNAL_STORE                     │  │
│  │                                                     │  │
│  │  ┌──────────────────┐    ┌────────────────────┐   │  │
│  │  │ InMemoryStore    │ OR │ PostgresStore      │   │  │
│  │  │ • Observe-only   │    │ • Multi-replica    │   │  │
│  │  │ • No external    │    │ • Durable          │   │  │
│  │  │   dependencies   │    │ • Atomic           │   │  │
│  │  └──────────────────┘    └────────────────────┘   │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ PostgreSQL
                          ▼
        ┌─────────────────────────────────────┐
        │    abuse_signal_windows             │
        │  • Per-subject window aggregates    │
        │  • Atomic counters                  │
        │  • Bounded JSONB collections        │
        ├─────────────────────────────────────┤
        │    abuse_actions                    │
        │  • Bounded enforcement actions      │
        │  • Expiry tracking                  │
        │  • Release binding provenance       │
        ├─────────────────────────────────────┤
        │    abuse_decisions                  │
        │  • Decision provenance              │
        │  • Already existed                  │
        └─────────────────────────────────────┘
```

### Database Schema

#### `abuse_signal_windows`

Stores per-subject aggregates for the current evaluation window.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `varchar(128)` | Deterministic: `sha256(subjectKey:windowStart)` |
| `subjectKey` | `varchar(64)` | HMAC digest of subject (never raw identifier) |
| `subjectKind` | `varchar(32)` | `principal`, `wallet`, or `network_prefix` |
| `windowStart` | `bigint` | Unix timestamp (ms) of fixed window start |
| `windowMs` | `integer` | Window duration in milliseconds |
| `expiresAt` | `bigint` | When window is eligible for cleanup |
| `total` | `integer` | Total observation count |
| `reads`, `writes`, `authFailures`, etc. | `integer` | Per-kind counters |
| `distinctRoutes` | `jsonb` | Bounded array of route groups |
| `routeSaturationHit` | `boolean` | True when distinct cap reached |
| `distinctCredentials` | `jsonb` | Bounded array of credential fingerprints |
| `duplicatePayloadCounts` | `jsonb` | Map of fingerprint → repeat count |
| `subjectsPerCredential` | `jsonb` | Map of credential → subject count |

**Indexes:**
- `UNIQUE (subjectKey, windowStart)` — ensures one window per subject per time period
- `(windowStart)` — for cross-replica credential stuffing queries
- `(expiresAt)` — for cleanup jobs

**Atomicity:** `record()` uses optimistic insert with conflict handling. On unique constraint violation, fetches the existing record, applies the observation, and saves atomically.

#### `abuse_actions`

Stores bounded, appealable enforcement actions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `varchar(32)` | Deterministic from decision context |
| `subjectKey` | `varchar(64)` | HMAC digest of subject |
| `kind` | `varchar(32)` | `none`, `observe`, `throttle`, `challenge`, `suspend` |
| `status` | `varchar(32)` | `active`, `expired`, `lifted`, `superseded` |
| `reasonCode` | `varchar(64)` | Versioned reason code |
| `startedAt`, `expiresAt` | `timestamptz` | Mandatory time bounds |
| `bindingChainId`, `releaseId`, etc. | — | Release provenance |
| `costMultiplier` | `real` | For throttle actions (≥1.0, ≤1000.0) |
| `escalationLevel` | `integer` | Position on ladder (0–10) |
| `appealable` | `boolean` | Always `true` (CHECK constraint) |

**Indexes:**
- `(subjectKey, startedAt)` — for action history queries
- `(expiresAt)` — for expiry filtering
- `(status)` — for active action lookups

**Enforcement reads:** `activeAction()` filters by `status = 'active'` AND `expiresAt > now`, so expired actions stop enforcement without operator intervention.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ABUSE_SIGNALS_SHARED_STORE` | `memory` | Store backend: `memory` or `postgres` |
| `ABUSE_SIGNALS_ENFORCEMENT_ENABLED` | `false` | Enable enforcement (requires shared store) |
| `ABUSE_SIGNALS_ENABLED` | `true` | Enable signal recording |

### Deployment Modes

#### Observe-Only Mode (Default)

```env
ABUSE_SIGNALS_ENABLED=true
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false
# ABUSE_SIGNALS_SHARED_STORE not set or =memory
```

- Uses in-memory store
- Records observations and decisions
- Never refuses requests
- Suitable for single-replica development, staging, or initial rollout
- No external dependencies

#### Multi-Replica Enforcement

```env
ABUSE_SIGNALS_ENABLED=true
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true
ABUSE_SIGNALS_SHARED_STORE=postgres
DATABASE_URL=postgresql://user:pass@host:5432/db
```

- Uses PostgreSQL-backed store
- Multiple replicas converge on same state
- Actions survive restarts
- Enforcement is active
- **Requires running migrations first**

## Deployment Guide

### Step 1: Run Migrations

```bash
npm run migration:run
```

This creates:
- `abuse_signal_windows` table
- `abuse_actions` table
- Indexes and CHECK constraints

### Step 2: Configure Environment

For multi-replica production:

```env
ABUSE_SIGNALS_SHARED_STORE=postgres
DATABASE_URL=postgresql://...
```

For observe-only mode (staging/dev):

```env
# ABUSE_SIGNALS_SHARED_STORE not set (defaults to memory)
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false
```

### Step 3: Enable Enforcement (When Ready)

**After** observing signal quality in production for a suitable period:

```env
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true
```

Restart all replicas. The startup validator ensures enforcement cannot be enabled with the in-memory store.

## Operational Considerations

### Startup Validation

The `AbuseSignalsStartupValidator` runs on module init and **aborts startup** if:

```
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true
  AND
ABUSE_SIGNAL_STORE is InMemoryAbuseSignalStore
```

Error message provides clear guidance:

```
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true requires a shared signal store.

The in-memory store is process-local and bounded: window aggregates,
decisions, and actions do not survive restarts and are not visible
across replicas.

To enable enforcement in a multi-replica deployment:
  1. Set ABUSE_SIGNALS_SHARED_STORE=postgres
  2. Ensure DATABASE_URL or DB_* variables are configured
  3. Run migrations: npm run migration:run
  4. Set ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true

To keep observe-only mode with the in-memory store:
  - Leave ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false (default)
```

This is **fail-closed behavior**: misconfigured enforcement cannot start.

### Window Cleanup

Windows expire when `now > expiresAt` (set to `windowStart + 2*windowMs` to allow for clock skew). Expired windows are not automatically deleted; implement a periodic cleanup job:

```sql
DELETE FROM abuse_signal_windows
WHERE "expiresAt" < extract(epoch from now() - interval '1 hour') * 1000;
```

Run this hourly or daily depending on traffic volume.

### Action Expiry

Actions expire when `now > expiresAt`. The read path (`activeAction()`) filters expired actions, so enforcement stops automatically. Expired action records can be archived or deleted after a retention period (e.g., 90 days).

### Monitoring

Key metrics to track:

- **Window record count:** Should stay bounded (one per subject per active window)
- **Action count by status:** Active vs. expired vs. lifted
- **Decision outcome distribution:** `actioned` vs. `suppressed` vs. `observed_only`
- **Store availability:** Error rate on `record()`, `windowFor()`, `activeAction()`

### Scaling Considerations

**Connection pool:** Each replica needs database connections for signal writes. Configure `DB_POOL_MAX` to accommodate burst traffic.

**Index maintenance:** JSONB columns and high write volume can cause index bloat. Run `REINDEX` or `VACUUM` periodically.

**Partitioning (future):** If window table grows large, partition by `windowStart` for efficient archival.

## Privacy and Security

### Subject Keys

Subject keys stored in `subjectKey` columns are **HMAC digests**, never raw addresses, wallets, or user IDs. The salt (`ABUSE_SIGNALS_SUBJECT_SALT`) must be:

- At least 32 characters
- Kept secret (never committed to version control)
- Rotated carefully (invalidates all existing windows)

### Credential Fingerprints

The `distinctCredentials` and `subjectsPerCredential` columns contain **salted digests** of credentials, never real passwords or tokens. These are produced by the caller (e.g., auth module) before observations reach the store.

### Error Messages

The store never logs or exposes:
- Raw subject keys
- Raw credential fingerprints
- Salts

Error messages contain only high-level context (e.g., "subject kind", "observation kind") and operational guidance.

## Atomicity Guarantees

### Window Updates

`record()` ensures atomic increments using this sequence:

1. **Optimistic insert:** Try to create a new window record
2. **Conflict handling:** On unique constraint violation (window exists), fetch the existing record
3. **Atomic update:** Apply observation, increment counters, update JSONB collections
4. **Save:** TypeORM `save()` uses `UPDATE ... WHERE id = ?`

**Concurrency:** Two replicas recording the same observation to the same window will:
- Both succeed
- Both see the accumulated total (no lost updates)
- Produce identical results (convergence)

### Bounded Collections

JSONB arrays (`distinctRoutes`, `distinctCredentials`, etc.) are capped at `ABUSE_WINDOW_LIMITS.distinctCap` (256). When the cap is reached:
- New distinct values are **not** added
- Saturation flag (`routeSaturationHit`) is set to `true`
- Existing values and their counts continue to update

This prevents unbounded growth from hostile traffic.

## Testing

### Multi-Instance Convergence

```typescript
// Two store instances fed the same observations
await storeA.record(subjectKey, kind, observation, windowMs, now);
await storeB.record(subjectKey, kind, observation, windowMs, now);

// Both see the same total
const windowA = await storeA.windowFor(subjectKey, kind, windowMs, now);
const windowB = await storeB.windowFor(subjectKey, kind, windowMs, now);

expect(windowA.total).toBe(2);
expect(windowB.total).toBe(2);
```

### Atomic Counter Operations

```typescript
// 10 concurrent record() calls
const promises = [];
for (let i = 0; i < 10; i++) {
  promises.push(storeA.record(subjectKey, kind, observation, windowMs, now));
}
await Promise.all(promises);

// All 10 observations are counted
const window = await storeA.windowFor(subjectKey, kind, windowMs, now);
expect(window.total).toBe(10);
```

### Expiry Filtering

```typescript
const expiredAction = {
  id: 'action-expired',
  expiresAt: new Date(now - 5 * 60 * 1000).toISOString(), // Past
  status: AbuseActionStatus.ACTIVE,
  // ...
};
await store.putAction(expiredAction);

// Expired action is not returned
const active = await store.activeAction(subjectKey, now);
expect(active).toBeNull();
```

### Fail-Closed Behavior

```typescript
const policy = { enforcementEnabled: true, /* ... */ };
const store = new InMemoryAbuseSignalStore();

const validator = new AbuseSignalsStartupValidator(policy, store);

// Startup aborts
expect(() => validator.onModuleInit()).toThrow(
  'ABUSE_SIGNALS_ENFORCEMENT_WITH_IN_MEMORY_STORE_FORBIDDEN'
);
```

## Migration from In-Memory to Shared Store

### Zero-Downtime Rollout

1. **Phase 1: Observe-only with shared store**
   ```env
   ABUSE_SIGNALS_SHARED_STORE=postgres
   ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false
   ```
   Deploy to all replicas. Windows and decisions are now durable, but no enforcement yet.

2. **Phase 2: Verify convergence**
   Monitor decision outcomes across replicas. Confirm that signal quality is acceptable.

3. **Phase 3: Enable enforcement**
   ```env
   ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true
   ```
   Rolling restart. Enforcement is now active across the fleet.

### Rollback

To roll back enforcement:

```env
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false
```

Restart replicas. Signals continue to be recorded, but no requests are refused.

To roll back to in-memory store:

```env
# Remove or comment out:
# ABUSE_SIGNALS_SHARED_STORE=postgres
ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false
```

Restart. Module returns to observe-only mode with in-memory storage.

## References

- **Issue:** [PREWAVE-BE-111 (#812)](https://github.com/DigiNodes/truthbounty-api/issues/812)
- **Dependencies:** PREWAVE-BE-086 (#681) for base abuse signals module
- **Related:** PREWAVE-BE-105 for durable appeal records
- **Migration:** `src/migrations/1793000000000-CreateSharedAbuseSignalStore.ts`
- **Store implementation:** `src/abuse-signals/postgres-abuse-signal.store.ts`
- **Startup validator:** `src/abuse-signals/abuse-signals-startup-validator.ts`
- **Tests:** `src/abuse-signals/postgres-abuse-signal.store.spec.ts`

## FAQ

### Q: Can I enable enforcement on a single replica for testing?

**A:** Yes, but use a dedicated test database. Set `ABUSE_SIGNALS_SHARED_STORE=postgres` and `ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true` on one replica. Other replicas can remain in observe-only mode.

### Q: What happens if the database becomes unavailable?

**A:** Store operations throw `ABUSE_SIGNAL_STORE_UNAVAILABLE`. The abuse signal service catches this and produces an `INDETERMINATE` decision. **Requests are denied** (fail closed) rather than allowed through.

### Q: How do I rotate the subject salt?

**A:** **Caution:** Rotating the salt invalidates all existing windows and actions, because subject keys are derived from `HMAC(salt, rawIdentifier)`. If you rotate the salt:

1. Existing windows will not match new observations (subjects appear as new)
2. Existing actions will not match new subject resolutions (enforcement is lost)

Only rotate the salt if you intentionally want to reset all abuse state. After rotation, consider clearing the `abuse_signal_windows` and `abuse_actions` tables.

### Q: Can I use a different backend (Redis, DynamoDB, etc.)?

**A:** Yes, implement the `AbuseSignalStore` interface. The module binds to `ABUSE_SIGNAL_STORE`, so any implementation that satisfies the interface will work. Ensure atomicity guarantees hold for your chosen backend.

### Q: What's the performance impact of the shared store?

**A:** Each observation writes one window record (or updates an existing one). At 1000 req/s with 100 distinct subjects per 5-minute window, expect ~100 writes/s to `abuse_signal_windows`. Use connection pooling and monitor query latency. JSONB updates are efficient, but watch for lock contention on high-traffic subjects.

### Q: Why are decisions stored separately from actions?

**A:** Decisions are immutable audit records of "what the module decided and why." Actions are mutable enforcement state (can be lifted, expired, superseded). Separating them keeps the decision log stable while allowing action lifecycle management.
