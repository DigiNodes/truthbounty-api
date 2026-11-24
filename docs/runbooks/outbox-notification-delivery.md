# Operations Runbook: Outbox & Notification Delivery System

## Component Summary
- **Module**: `OutboxModule` (`src/outbox/`)
- **Persistence**: Prisma `OutboxEvent` table
- **Queue**: BullMQ `notifications` queue
- **Processor**: `NotificationProcessor` (`src/notifications/services/notification.processor.ts`)

---

## Observability & Metrics

Prometheus metrics exposed by `MetricsService`:
- `outbox_batch_processed_total`: Number of outbox polling batches executed
- `outbox_events_dispatched_total`: Outbox events successfully queued to BullMQ
- `outbox_events_relay_failed_total`: Transient relay failures (retried automatically)
- `outbox_events_dead_lettered_total`: Events moved to `DEAD_LETTER` status after max retries

---

## Alert Thresholds & Troubleshooting

### Alert: High Pending Outbox Count (`outbox_pending_count > 500`)
**Symptom**: Events accumulating in `OutboxEvent` with status `PENDING`.
**Root Cause**:
1. Redis connection down or queue blocked.
2. `OutboxScheduler` node crashing or frozen.

**Resolution Steps**:
1. Check application logs for `OutboxScheduler` or `OutboxService` errors.
2. Verify Redis cluster connectivity: `redis-cli ping`.
3. Check BullMQ queue depth via BullBoard interface (`/admin/queues`).

---

### Alert: Dead Letter Accumulation (`outbox_dead_letter_count > 10`)
**Symptom**: Events in `DEAD_LETTER` status.
**Root Cause**:
1. Corrupted JSON payload in `OutboxEvent.payload`.
2. Worker crash loop or downstream channel outage exceeding maxRetries (5).

**Resolution Steps**:
1. Query dead-lettered events:
   ```sql
   SELECT id, "eventType", "aggregateId", "lastError", "createdAt"
   FROM "OutboxEvent"
   WHERE status = 'DEAD_LETTER'
   ORDER BY "createdAt" DESC
   LIMIT 20;
   ```
2. Inspect `lastError` column for root cause details.
3. Fix underlying cause and reset status to `PENDING` to re-trigger delivery:
   ```sql
   UPDATE "OutboxEvent"
   SET status = 'PENDING', "retryCount" = 0, "lastError" = NULL
   WHERE id = '<event_id>';
   ```
