# Read-Path Load Budgets & Performance SLA (V2-BE-086)

## Overview

This document defines the production Performance SLA and Load Budgets for high-frequency read paths in the TruthBounty V2 API.

---

## 1. Latency & Throughput Targets

| Path | Endpoint | SLA Target (p95) | SLA Target (p99) | Target RPS |
| :--- | :--- | :--- | :--- | :--- |
| **Notification List** | `GET /api/notifications` | `< 100ms` | `< 250ms` | 250 req/sec |
| **Unread Count** | `GET /api/notifications/unread-count` | `< 50ms` | `< 120ms` | 500 req/sec |
| **Delivery History** | `GET /api/notifications/delivery-history` | `< 150ms` | `< 300ms` | 100 req/sec |
| **Outbox Relay** | Internal Background Poller | `< 500ms` | `< 1000ms` | 1000 events/min |

---

## 2. Optimization Architecture

### Redis Caching & Fast-Path Idempotency
- **Unread Count Cache**: Key `cache:unread_count:${userId}` with TTL = 60s, invalidated on new notification creation.
- **Idempotency Guard**: Key `idempotency:notification:${idempotencyKey}` via Redis `SETNX` with TTL = 86400s (24 hours).

### Database Indexing Strategy
- `OutboxEvent`: `@@index([status, scheduledAt])`, `@@index([idempotencyKey])`
- `DeliveryHistory`: `unique` index on `idempotencyKey`

---

## 3. Verification & Soak Testing

Run the automated soak test script to verify compliance:

```bash
# Run 30-second soak test with 20 concurrent workers
npx ts-node scripts/soak-test.ts --duration 30 --concurrency 20 --url http://localhost:3000
```

Automated jest spec:
```bash
npx jest test/load/load-budget.spec.ts
```
