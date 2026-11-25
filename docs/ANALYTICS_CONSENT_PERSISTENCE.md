# Analytics Consent Persistence

## Overview

`AnalyticsConsentService` persists consent records in PostgreSQL so that grant, withdrawal, do-not-track, and subject lifecycle state survive restarts and are immediately visible across all API replicas. The previous process-local `Map` has been replaced by this durable implementation.

> **Scope**: This covers optional product analytics only. Operational Prometheus metrics (`MetricsService`) are independent and unaffected by any consent state.

---

## Tables

Both tables are created by the Prisma migration `20261123220000_persist_analytics_consent`.

### `analytics_consent_current`

One row per pseudonymous subject. The primary key is a 64-character hex HMAC-SHA-256 digest of the raw subject identifier — raw IDs are never stored.

| Column | Type | Notes |
|---|---|---|
| `subject_key` | `varchar(64)` | HMAC-SHA-256 of subject ID, keyed by `ANALYTICS_CONSENT_SUBJECT_KEY` |
| `policy_version` | `varchar(64)` | Consent policy version accepted by the subject |
| `status` | `varchar(16)` | `none`, `granted`, or `withdrawn` |
| `granted_at` | `timestamptz` | Set when status transitions to `granted` |
| `withdrawn_at` | `timestamptz` | Set when status transitions to `withdrawn` |
| `do_not_track` | `boolean` | DNT/GPC-style signal; independent of `status` |
| `updated_at` | `timestamptz` | Maintained on every upsert |

Database CHECK constraints enforce:
- `subject_key` matches `^[0-9a-f]{64}$`
- `status` is one of the three valid values
- `policy_version` is non-empty
- Timestamp consistency per status (e.g. `granted_at` must be non-null when `status = 'granted'`)

### `analytics_consent_history`

Append-only lifecycle events for subject rotation and deletion. Subject keys here are also HMAC digests; raw identifiers are never stored.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Random UUID |
| `event_type` | `varchar(32)` | `subject_rotated` or `subject_deleted` |
| `subject_key` | `varchar(64)` | Null for `subject_deleted` |
| `related_subject_key` | `varchar(64)` | Null for `subject_deleted` |
| `occurred_at` | `timestamptz` | Wall-clock time of the event |
| `retention_until` | `timestamptz` | Rows are eligible for purge after this date |

History rows for `subject_deleted` store `NULL` for both key columns so no subject-linked information is retained after deletion.

Retention is 30 days. Purge runs nightly at 02:00 UTC via the `@Cron` scheduled task in `AnalyticsConsentService.purgeExpiredHistory`.

---

## Consistency model

All mutating operations (`grant`, `withdraw`, `setDoNotTrack`, `rotateSubject`, `deleteSubject`) run inside a Postgres transaction. Before any read-modify-write they acquire a per-subject advisory transaction lock using `pg_advisory_xact_lock(hashtextextended(subjectKey, 0))`. When an operation touches two subjects (rotation), both locks are acquired in sorted order to prevent deadlocks.

`collectIfValid` runs the consent check and the analytics collection callback inside the same transaction and under the same advisory lock. This ensures that a concurrent withdrawal cannot race the collection: either the write sees the granted record and collection proceeds, or it sees the withdrawn record and fails closed.

---

## Configuration

| Env var | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string — sole persistence authority |
| `ANALYTICS_CONSENT_SUBJECT_KEY` | Yes | HMAC signing secret; must be at least 32 characters |

If `ANALYTICS_CONSENT_SUBJECT_KEY` is absent or shorter than 32 characters, every consent operation throws `ServiceUnavailableException` (fail closed).

---

## Fail-closed behaviour

- Missing or short `ANALYTICS_CONSENT_SUBJECT_KEY` → `ServiceUnavailableException` on every call.
- Database unavailable → exception propagates; `collectIfValid` callers must catch and skip optional analytics, not fail the main request.
- Stale policy version in the stored record → `hasValidConsent` returns `false`; collection is blocked until the subject explicitly renews.
- `grant` with any policy version other than `CURRENT_CONSENT_POLICY_VERSION` → `BadRequestException`.

---

## Subject lifecycle

| Operation | Effect |
|---|---|
| `grant(subjectId)` | Upserts `status=granted`, `policy_version=current`, clears `withdrawn_at` |
| `renew(subjectId, version)` | Alias for `grant`; rejects stale policy versions |
| `withdraw(subjectId)` | Upserts `status=withdrawn`, sets `withdrawn_at`; blocks further collection immediately across all replicas |
| `setDoNotTrack(subjectId, true)` | Sets `do_not_track=true`; consent status is not changed |
| `rotateSubject(old, new)` | Atomically deletes consent and history for both subjects, purges `AiUsageMetric` rows, inserts a `subject_rotated` history row with HMAC keys only |
| `deleteSubject(subjectId)` | Atomically deletes consent, history, and usage metrics for the subject; inserts a `subject_deleted` history row with both key columns NULL |

Rotation and deletion are atomic: the advisory lock ensures no collection can observe an intermediate state.

---

## Operational metrics separation

`AnalyticsConsentService` and `AnalyticsService` are entirely separate from `MetricsService` (Prometheus). Consent state has no effect on operational counters, gauges, or histograms. Do not route Prometheus scrapes through the consent check.

---

## Module registration

`AnalyticsModule` is registered in `AppModule` directly (in addition to being re-exported from `AiAssistantModule`). This ensures the nightly `purgeExpiredHistory` cron job is active independent of the AI assistant feature.

---

## Tests

| File | Coverage |
|---|---|
| `src/analytics/analytics-consent.service.spec.ts` | Grant/renew/withdraw/DNT/rotate/delete survive restart; withdrawal propagates across replicas; stale policy invalidates consent; concurrent operations serialize; deletion retains only anonymous history; retention purge; fail-closed on missing key |
| `src/analytics/analytics.service.spec.ts` | No collection without consent; minimization and pseudonymization; rollback on transaction failure; withdrawn/stale-policy blocks; DNT persisted before rejection; DB failure propagates; forbidden fields rejected |
| `src/ai-assistant/services/ai-assistant.service.spec.ts` | Usage metrics written inside consent transaction; skipped without consent |
