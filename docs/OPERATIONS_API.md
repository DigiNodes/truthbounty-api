# Protected Operations, Safe-Retry and Audit API (UX-BE-004, #595)

Versioned, protected interfaces for the privileged operations boards. The API is
**read-only with respect to protocol state**: it publishes bounded operational
queue reads, safe-retry eligibility/submission, and audit-record lookup. No
endpoint edits claim, verification, dispute, settlement, reward, treasury,
governance, or pause state — contracts and canonical events remain authoritative.

OpenAPI version: **1.0.0** (surface added at API version `1.0`).

## Endpoints

All routes are admin-plane protected (`AdminGuard` + `RolesGuard`).

| Method | Path | Capability | Roles |
| --- | --- | --- | --- |
| `GET` | `/v1/operations/queue` | `OPERATIONS_QUEUE_READ` | super_admin, administrator, security_analyst, auditor |
| `GET` | `/v1/operations/queue/:id` | `OPERATIONS_QUEUE_READ@ | super_admin, administrator, security_analyst, auditor |
| `GET`| `/v1/operations/queue/:id/retry-eligibility` | `OPERATIONS_RETRY_READ@ | super_admin, administrator, security_analyst, auditor |
| `POST` | `/v1/operations/queue/:id/retry` | `OPERATIONS_RETRY_SUBMIT` | super_admin, administrator |
| `GET` | `/v1/operations/audit/:auditId` | `OPERATIONS_AUDIT_READ` | super_admin, administrator, security_analyst, auditor |
| `POST` | `/v1/operations/queue/:id/replay` | `OPERATIONS_REPLAY_SUBMIT` | super_admin, administrator |
| `POST` | `/v1/operations/queue/:id/replay/pause` | `OPERATIONS_REPLAY_CONTROL` | super_admin, administrator |
| `POST` | `/v1/operations/queue/:id/replay/resume` | `OPERATIONS_REPLAY_CONTROL` | super_admin, administrator |

### Queue item shape

Every item carries immutable identifiers and the metadata the boards need to act
without guessing:

The replay surface adds the dead-letter linkage fields below.

`id` (immutable work id), `releaseId`, `capability`, `authoritySource`,
`authorityExpiresAt`, `status`, `impact`, `duplicationRisk`, `freshness`,
`attempts`, `maxAttempts`, `retryable`, `version`, `updatedAt`, `summary`.

### Retry eligibility

GET  /v1/operations/queue/:id/retry-eligibility returns:

```json
{ "id": "queue-001", "eligible": true, "reason": null, "attemptsRemaining": 4,
  "preconditionToken": "a1b2c3d4e5f60718293a4b5c6d7e8f90" }
```

The frontend determines retryability directly from `eligible`/`reason` — the
nver has to infer it from other fields.

### Retry submission

POST /v1/operations/queue/:id/retry requires:

| Input | Where | Why |
| --- | --- | --- |
| `Idempotency-Key` | header | Duplicate keys replay the original outcome; they never re-execute. |
| `X-Precondition-Token` | header (or `preconditionToken` body) | Must match the item's current version, or the request is rejected as stale. |
| `X-Authority-Capability` | header | Must equal the item's required capability. |
| `X-Authority-Expires-At` | header (ISO) | Revalidated on every request; missing/expired/ambiguous fails closed. |
| `reason?`, `force?` | body | Audited replay context; `force` only bypasses plain non-retryable, never a confirmed duplication risk. |

Authentication is not authorization: capability and expiry are revalidated on
every request.

## Dead-Letter Replay (PREWAVE-BE-049)

Dead-letter replay is a distinct, higher-risk surface from plain retry. It is
**denied by default** and only proceeds when every guard below is satisfied.

### Replay request shape

`POST /v1/operations/queue/:id/replay` requires:

| Input | Where | Why |
| --- | --- | --- |
| `Idempotency-Key` | header | Required. Duplicate keys replay the stored outcome; they never re-execute. A duplicate cannot produce a second effect. |
| `X-Precondition-Token` | header (or `preconditionToken` body) | Required. Must match the item's current version, or the request is rejected as stale. |
| `X-Authority-Capability` | header | Required. Must equal `OPERATIONS_REPLAY_SUBMIT` and the item's required capability. |
| `X-Authority-Expires-At` | header (ISO) | Required. Revalidated on every request; missing/expired/ambiguous fails closed. |
| `reason` | body (required) | Non-empty operator rationale, audited with the replay record. |
| `dryRun` | body (required) | When `true`, evaluates and returns the decision without enqueuing work. |
| `originalPayloadHash` | body (required) | Sha-256 hex of the original dead-letter payload. Must match the stored hash or the replay is rejected as conflict. |
| `batchLimit` | body (optional) | Bounded batch size; defaults to `1` and is capped at the configured maximum. Exceeding the cap fails closed. |

### Replay guards (fail closed)

1. **Authorization.** Requires `OPERATIONS_REPLAY_SUBMIT` capability and a
   valid, non-expired authority. Missing, stale, revoked, or ambiguous authority
   returns `DENIED ` or `STALE_AUTHORITY`.
2. **Reason.** A replay without a non-empty reason is rejected. The reason is
   recorded in the audit record.
3. **Bounds.** confirmed duplication risk, quarantined items, and exceeding the
   configured batch cap all fail closed.
4. **Dry run.** `dryRun` is required and must be explicit; it never enqueues
   work and never advances the item version.
5. **Original payload hash.** `originalPayloadHash` must match the stored
   dead-letter payload hash; a mismatch is `CONFLICT`.
6. **Release/schema compatibility.** Replay is prevented across release or schema
   incompatibility. The item's `releaseId`, chain ID, deployment block, and
   artifact checksum must match the current authoritative release; a stale or mismatched
   release returns `STALE_RELEASE`.
7. **Audit record.** Every accepted or rejected replay carries a stable `auditId`.
   The audit record links the original dead-letter reference to the replay
   reference immutably.

### Replay response

```json
{ "id": "queue-001", "auditId": "audit-replay-001", "dryRun": false,
  "accepted": true, "duplicate": false, "processed": 1,
  "originalRef": "dl-001", "replayRef": "replay-001",
  "releaseId": "release-2025-01", "schemaVersion": "v1" }
```

When a duplicate `Idempotency-Key` is seen, the stored outcome is returned with
`duplicate: true` and the same `originalRef`/`replayRef`; no second effect is
produced.

### Bounded batch control

`POST /v1/operations/queue/:id/replay/pause` and
`POST /v1/operations/queue/:id/replay/resume` let operators stop and resume
bounded replay batches. Both require the same authority, precondition, and audit
guarantees as replay submission. Pausing is idempotent; resuming a batch that is
already running is a no-op. Batches always respect the configured maximum and
stop at the first failure or poison message.

### Replay error codes

In addition to the canonical error codes below, replay requests may return:

| `errorCode` | HTTP | Meaning |
| --- | --- | --- |
| `STALE_RELEASE` | 409 | Item release/schema is incompatible with the current authoritative release. |
| `PAYLOAD_HASH_MISMATCH` | 409 | `originalPayloadHash` does not match the stored payload. |
| `BATCH_LIMIT_EXCEEDED` | 422 | Requested batch size exceeds the configured maximum. |
| `DRY_RUN_REQUIRED` | 400 | `dryRun` was not supplied. |
| `REASON_REQUIRED` | 400 | `reason` was missing or empty. |

## Canonical results

Every accepted or rejected protected request carries a **stable audit
identifien** (`auditId`). Rejections use the canonical envelope
`{ statusCode, errorCode, message, auditId, timestamp } ` with one of:

| `errorCode` | HTTP | Meaning |
| --- | --- | --- |
| `DENIED` | 403 | Caller authority lacks the required capability. |
| `STALE_AUTHORITY` | 403 | Authority missing, expired, or ambiguous. |
| `STALE_PRECONDITION` | 409 | Precondition token missing/stale; re-read and retry. |
| `CONFLICT` | 409 | Idempotency key reused for a different item. |
| `ALREADY_COMPLETED` | 409 | The operation already completed. |
| `UNSAFE_TO_RETRY` | 409 | Quarantined item or confirmed duplication risk. |
| `NOT_RETRYABLE` | 409 | Item is not eligible for retry (use `force` to override). |
| `DEPENDENCY_UNAVAILABLE` | 503 | Required dependency unavailable. |
| `RATE_LIMITED` | 429 | Throttled by the wallet/route throttler. |

## Guarantees

1. **No duplicate protocol mutation.** A retry re-enqueues existing work through
   the queue source, which carries its own deterministic idempotency key; a
   duplicate `Idempotency-Key` replays the stored outcome instead of re-running.
   The same holds for dead-letter replay: one message cannot produce duplicate
   effects.
2. **Fail closed.** Missing, stale, revoked, or ambiguous authority never
   defaults to allowed. Replay is denied by default and requires authority,
   reason, bounds, dry run, original payload hash, and an audit record.
3. **Immutable linkage.** Original and replay references are linked immutably in the
   audit record; neither reference is rewritten by a later replay.
4. **Sanitized audit.** Records exclude secrets, protected evidence,
   credentials, raw authorization headers, and internal topology.
5. **Read-only protocol outcomes.** No operational endpoint edits protocol
   state; the only write-shaped handlers are the idempotent retry submission and the
   bounded, audited replay controls.
6. **Chain-bound data.** Replay decisions are bound to chain ID, release ID, deployment block, and artifact checksum; stale, ambiguous, missing, or unauthorized
   state fails closed.

## Required tests

- `Unauthorized:` replay without `OPERATIONS_REPLAY_SUBMIT` or with expired
  authority is denied.
- `Stale release:` replay across incompatible release/schema is rejected with
   `STALE_RELEASE`.
- `Duplicate replay:` a repeated `Idempotency-Key` returns the stored outcome
   without a second effect.
- `Batch limit:` a batch exceeding the configured maximum fails closed.
- `Poison message:` a poison message halts the batch and is quarantined.
- `Partial failure:` a failure in a batch stops further replay and is audited.
- `Audit:` every accepted/rejected replay produces a stable audit record linking
   original and replay references immutably.

## Fixtures

Deterministic, sanitized frontend fixtures for every state live in
`test/fixtures/contracts/operations-contract.fixtures.ts`, validated by
`operations-contract.spec.ts` (vocabulary, exact field sets, sanitization).
