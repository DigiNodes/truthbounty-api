# V2 Transactional Outbox — Operator & Developer Runbook

**Issue:** #465 V2-BE-113  
**Persistence boundary:** TypeORM / PostgreSQL (`v2_outbox_messages`)  
**Status:** production-ready (migration `1790300000000-CreateV2OutboxMessages`)

---

## Overview

The V2 Transactional Outbox provides at-least-once, crash-safe delivery of
application-side side-effects (notification dispatch, webhook fire, realtime
broadcast) that must be triggered only after a state-changing database
transaction commits.

It is **separate from** the Prisma-based `outbox_events` table used by the
legacy notifications module. Both tables coexist without interference; they
serve different consumers and use different persistence paths.

---

## Architecture

```
Domain service
  │
  │  TransactionRunner / dataSource.transaction(manager => {
  │    manager.save(DomainEntity)          ← state change
  │    v2OutboxService.publishWithManager  ← side-effect record
  │  })                                    ← single atomic commit
  │
  ▼
v2_outbox_messages (PostgreSQL)
  │
  ▼
V2OutboxWorker (@Cron every 5 s)
  │  FOR UPDATE SKIP LOCKED (batch=50)
  │  → PROCESSING (+ processingDeadline)
  │  → BullMQ queue: "v2-outbox"
  │  → DISPATCHED (jobId recorded)
  │
  └─ on failure: retryCount++, reset to PENDING
                 on exhaustion: → DEAD_LETTER
```

---

## Message lifecycle

| Status | Meaning |
|--------|---------|
| `PENDING` | Committed, not yet claimed by a worker. |
| `PROCESSING` | Claimed by a worker; dispatch in flight. Expires at `processingDeadline`. |
| `DISPATCHED` | Successfully placed on the BullMQ queue. Normal terminal state. |
| `DEAD_LETTER` | Dispatch failed `maxRetries` times (default 5). Requires operator action. |

---

## Normal operations

### Check pending backlog

```sql
SELECT COUNT(*) FROM v2_outbox_messages WHERE status = 'PENDING';
```

If this number grows continuously and workers are running, BullMQ/Redis may be
unavailable. Check Redis connectivity first.

### Check in-flight / stuck messages

```sql
SELECT id, aggregateType, aggregateId, eventType, retryCount,
       processingDeadline, createdAt
FROM v2_outbox_messages
WHERE status = 'PROCESSING'
ORDER BY processingDeadline ASC;
```

Rows in `PROCESSING` with a `processingDeadline` in the past were left by a
crashed worker. The `recoverStuckMessages` pass resets them to `PENDING`
automatically on the next worker poll (within 5 seconds). No manual intervention
is needed unless rows persist in `PROCESSING` for more than 60 seconds.

### Check dead-letter queue

```sql
SELECT id, aggregateType, aggregateId, eventType, retryCount,
       lastError, createdAt
FROM v2_outbox_messages
WHERE status = 'DEAD_LETTER'
ORDER BY createdAt DESC
LIMIT 50;
```

`DEAD_LETTER` rows are never silently discarded. They remain in the table until
an operator replays or discards them.

---

## Replaying a dead-letter message

To replay a single message, reset its status and retryCount:

```sql
UPDATE v2_outbox_messages
SET status      = 'PENDING',
    retryCount  = 0,
    lastError   = NULL,
    "updatedAt" = now()
WHERE id = '<uuid>'
  AND status = 'DEAD_LETTER';
```

The next worker poll (within 5 seconds) will attempt redelivery.

To replay all dead-letter messages for a given aggregate:

```sql
UPDATE v2_outbox_messages
SET status      = 'PENDING',
    retryCount  = 0,
    lastError   = NULL,
    "updatedAt" = now()
WHERE aggregateType = 'claim'
  AND status = 'DEAD_LETTER';
```

**Before replaying:** confirm the downstream consumer (BullMQ processor, webhook
handler, etc.) is idempotent. The `jobId = outbox-<idempotencyKey>` in BullMQ
provides queue-level deduplication, but the application consumer must handle
duplicate deliveries safely.

---

## Discarding a dead-letter message

Only discard a message after confirming the domain operation it represents either
completed by another path or is no longer relevant.

```sql
DELETE FROM v2_outbox_messages
WHERE id = '<uuid>'
  AND status = 'DEAD_LETTER';
```

Deletion is irreversible. Prefer marking as replayed over deletion unless the
message is confirmed stale.

---

## Prometheus metrics

All counters are registered lazily via `MetricsService.incrementCounter()` and
are scrapable at the `/metrics` endpoint.

| Metric | Description |
|--------|-------------|
| `v2_outbox_batch_claimed_total` | Messages claimed from the DB per poll cycle. |
| `v2_outbox_dispatched_total` | Messages successfully dispatched to BullMQ. |
| `v2_outbox_retry_total` | Dispatch attempts that failed transiently (row reset to PENDING). |
| `v2_outbox_dead_lettered_total` | Messages transitioned to DEAD_LETTER. |
| `v2_outbox_recovered_total` | Stuck PROCESSING rows reset to PENDING by crash recovery. |

### Recommended alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Outbox backlog growing | `rate(v2_outbox_dispatched_total[5m]) == 0` AND pending > 0 | Critical |
| Dead letters accumulating | `increase(v2_outbox_dead_lettered_total[1h]) > 5` | Warning |
| Crash recovery firing | `increase(v2_outbox_recovered_total[10m]) > 0` | Info |

---

## Structured log events

| Logger | Level | Event |
|--------|-------|-------|
| `V2OutboxWorker` | `debug` | Poll cycle started, messages claimed, message dispatched. |
| `V2OutboxWorker` | `warn` | Transient dispatch failure, retry scheduled; stuck rows recovered. |
| `V2OutboxWorker` | `error` | Message dead-lettered; poll cycle error. |
| `V2OutboxService` | `debug` | Message published inside transaction. |

Log fields always include `id`, `eventType`, `aggregateType`, `aggregateId`. No
PII, credentials, or protocol state is logged.

---

## Developer: writing a message inside a transaction

```typescript
import { V2OutboxService } from '../v2/outbox/v2-outbox.service';
import { TransactionRunner }  from '../database/transaction.runner';

@Injectable()
export class ClaimService {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly outbox: V2OutboxService,
  ) {}

  async settleClaim(claimId: string, userId: string): Promise<void> {
    await this.txRunner.run(async (manager) => {
      // 1. Domain state change — must use the same manager
      const claimRepo = manager.getRepository(ClaimReadModel);
      await claimRepo.update(claimId, { state: 'settled' });

      // 2. Atomically record the delivery work
      await this.outbox.publishWithManager(manager, {
        aggregateType: 'claim',
        aggregateId:   claimId,
        eventType:     'notification.send',
        payload: {
          channel:      'in_app',
          recipientIds: [userId],        // opaque IDs only, never PII
          referenceId:  claimId,
        },
      });
      // If this transaction rolls back, the outbox row is also rolled back.
      // If it commits, the worker delivers the message within 5 seconds.
    });
  }
}
```

### Rules for payload content

The `payload` field is routing metadata only. It **must not** contain:
- Private keys or wallet credentials
- User PII (email, name, phone)
- Settlement amounts, reward values, or governance state
- Raw protocol state that would make the API authoritative over chain data
- Mock or placeholder production values

Use opaque IDs and channel routing hints only.

---

## Developer: importing the module

Add `V2OutboxModule` to any feature module that needs to publish outbox messages:

```typescript
import { V2OutboxModule } from '../v2/outbox/v2-outbox.module';

@Module({
  imports: [V2OutboxModule],
  // ...
})
export class YourFeatureModule {}
```

`V2OutboxModule` exports `V2OutboxService`. The worker (`V2OutboxWorker`) is
registered as a provider within the module and starts its poll cron automatically.

---

## Migration

### Applying (forward)

```bash
npm run migration:run
```

This runs `1790300000000-CreateV2OutboxMessages`, which creates:
- Table `v2_outbox_messages` with all constraints and indexes
- Trigger `trg_v2_outbox_updated_at` (keeps `updatedAt` current)
- Function `v2_set_updated_at()` (shared; not dropped on rollback)

### Verifying from a clean database

```bash
npm run migration:run
# Confirm table exists:
psql $DATABASE_URL -c "\d v2_outbox_messages"
```

### Rolling back

```bash
npm run migration:revert
```

`down()` drops the table, indexes, and trigger. The shared function
`v2_set_updated_at()` is intentionally preserved; remove it manually if no
other table uses it.

**Production rollback prerequisite:** drain all PENDING / PROCESSING messages
before reverting, or they will be silently lost.

---

## Security constraints

- **Optimism/EVM only.** No Stellar, Soroban, Freighter, or alt-chain runtime
  paths are introduced.
- **TypeORM only.** This table is within the TypeORM/PostgreSQL persistence
  boundary. It does not use Prisma.
- **Read-only downstream.** The worker reads `v2_outbox_messages` and writes
  to BullMQ. It never mutates `v2_canonical_events`, evidence, verification,
  dispute, or any other protocol table.
- **Fail-closed.** If BullMQ is unavailable, delivery fails as a delivery
  failure on the outbox row. It does not fall back to fabricated success or
  mutate protocol state.
- **No secrets in payload.** Enforced by the payload interface contract and
  documented validation rules.

---

## Known limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| `FOR UPDATE SKIP LOCKED` is PostgreSQL-specific. | Integration tests use SQLite (no lock). Concurrent claim exclusion is verified at unit level via mocks. | Verified in staging against PostgreSQL before merging. |
| Worker polls every 5 seconds. | Max delivery latency is ~5 seconds under normal conditions. | Acceptable for non-real-time side-effects; adjustable via `CronExpression`. |
| `maxRetries` defaults to 5; non-retryable errors (VALIDATION, AUTHORIZATION, UNKNOWN per retry-utils) dead-letter immediately. | Mis-classified errors may dead-letter too aggressively. | Review `classifyError` patterns in `queue/retry-utils.ts` if new error types emerge. |
| `v2_set_updated_at()` is not dropped on migration rollback. | Harmless orphaned function. | Remove manually after confirming no other trigger uses it. |
