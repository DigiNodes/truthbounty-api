# Sybil Score Appeal Persistence (PREWAVE-BE-103)

## Overview

Sybil score appeals are persisted to the database via Prisma, replacing the
previous in-memory `Map<string, SybilAppealRecord[]>` storage. Appeals are
now durable across service restarts, shared across API instances, and
provide a complete audit trail.

## Database Model

The `SybilAppeal` Prisma model (see `prisma/schema.prisma`) stores:

| Field                    | Type      | Description                                              |
| ------------------------ | --------- | ------------------------------------------------------- |
| `appealId`               | `String`  | Stable external identifier (UUID), unique              |
| `userId`                 | `String`  | Owner of the appeal (FK to `User`, cascade delete)    |
| `status`                 | `String`  | `SUBMITTED` \| `UPHELD` \| `RESOLVED` \| `REJECTED`   |
| `reason`                 | `String`  | User-supplied justification (5–2000 chars)             |
| `previousScore`          | `Float`   | Composite score before appeal                           |
| `previousRiskScore`      | `Float`   | Risk score before appeal                                |
| `newScore`               | `Float`   | Recomputed composite score                              |
| `newRiskScore`           | `Float`   | Recomputed risk score                                   |
| `modelVersion`           | `String`  | Model version used for recomputation                    |
| `recomputedAt`           | `DateTime`| Timestamp of the recomputation                          |
| `provenanceDigest`       | `String`  | SHA-256 digest binding appeal to exact computation     |
| `additionalEvidenceSummary` | `String?` | Privacy-safe JSON summary (no sensitive data)     |
| `reviewerId`             | `String?` | Identity of the reviewer (admin/moderator)            |
| `reviewedAt`             | `DateTime?`| When the review occurred                              |
| `reviewNotes`            | `String?` | Reviewer notes                                          |
| `idempotencyKey`         | `String`  | SHA-256 hash preventing duplicate submissions          |

### Indexes

- `SybilAppeal_appealId_key` — unique on `appealId`
- `SybilAppeal_idempotencyKey_key` — unique on `idempotencyKey`
- `SybilAppeal_userId_createdAt_idx` — user history lookup
- `SybilAppeal_status_createdAt_idx` — admin status filtering
- `SybilAppeal_userId_status_idx` — user + status queries
- `SybilAppeal_modelVersion_idx` — model version analysis

## Migration

Migration: `20261123131110_add_sybil_appeal_persistence`

```bash
npm run migration:run     # apply
npm run migration:revert  # rollback (see rollback notes below)
```

### Rollback

The migration creates a single table with no data transformations. Rolling
back drops the `SybilAppeal` table:

```sql
DROP TABLE IF EXISTS "SybilAppeal";
```

No foreign keys from other tables reference `SybilAppeal`, so rollback does
not orphan data in dependent tables. The `User.sybilAppeals` relation is
one-sided (User → SybilAppeal), so dropping the table is safe.

## Idempotency

Duplicate appeal submissions within a 5-minute window are rejected and the
existing appeal is returned instead. The idempotency key is a SHA-256 hash
of `userId + reasonPrefix + timeWindowBucket`:

```
idempotencyKey = SHA256(userId + ":" + reasonPrefix[:100] + ":" + floor(now / 5min))
```

This prevents accidental double-submission while allowing different reasons
or submissions after the window expires.

## Authorization

| Endpoint                              | Method | Access                          |
| ------------------------------------- | ------ | ------------------------------- |
| `GET /sybil/users/:userId/appeals`    | GET    | Anyone (returns user's appeals) |
| `GET /sybil/appeals/:appealId`        | GET    | Owner or reviewer (JWT auth)    |
| `POST /sybil/appeals/:appealId/review`| POST   | Admin/moderator only            |
| `GET /sybil/appeals`                  | GET    | Admin/moderator only            |

Non-owners without reviewer privileges receive a `404` (not `403`) when
accessing another user's appeal, to avoid confirming the appeal's existence.

## Status Transitions

1. **SUBMITTED** → set automatically when an appeal is created. The service
   evaluates the recomputed score and sets the initial status to `RESOLVED`
   (score improved) or `UPHELD` (score did not improve).
2. **UPHELD / RESOLVED / REJECTED** → set by an authorized reviewer via
   `reviewAppeal()`. Once reviewed (`reviewerId` and `reviewedAt` are set),
   further transitions are rejected with `ConflictException`.

## Privacy

The `additionalEvidenceSummary` field stores only privacy-safe evidence.
Before persistence, the service strips these sensitive fields:

- `nullifierHash`
- `proof`
- `privateKey`
- `seedPhrase`
- `walletAddresses`

Appeal records returned by any endpoint never include raw sensitive data.
The public appeal views and logs do not leak nullifier hashes, ZK proofs,
wallet addresses, or private keys.

## Provenance Binding

Each appeal record is cryptographically bound to the exact recomputation
that produced it:

- `provenanceDigest` — SHA-256 of the computation inputs (userId, model
  version, authority, component scores, composite score, risk score,
  missing/stale features). This digest matches what `recomputeScore()`
  produces for the same inputs.
- `modelVersion` — the Sybil scoring model version used.
- `recomputedAt` — timestamp of the recomputation.

Different model versions produce different digests, so an appeal is always
traceable to the exact model and inputs that generated the score.

## Service Methods

### `submitAppeal(userId, appealRequest)`

Creates a durable appeal record. Idempotent within the time window. Returns
the `SybilAppealRecord`.

### `getAppeals(userId)`

Returns all appeals for a user from the database, ordered by most recent.

### `getAppealById(appealId, requestingUserId, isReviewer)`

Returns a single appeal. Throws `NotFoundException` if the appeal doesn't
exist or the requester is neither the owner nor an authorized reviewer.

### `reviewAppeal(appealId, reviewerId, newStatus, reviewNotes?)`

Updates appeal status and records the reviewer. Throws `ConflictException`
if the appeal has already been reviewed.

### `getAppealsWithFilters(filters)`

Admin endpoint returning paginated, filtered appeals with total count.

## Testing

The test suite (`sybil-appeal-persistence.spec.ts`) covers:

- **Durability**: Appeals survive simulated restarts; reads are consistent
  across instances.
- **Owner isolation**: Only the owner or authorized reviewers can access
  appeal details.
- **Idempotency**: Duplicate submissions return the existing record.
- **Concurrent updates**: Concurrent submissions from different users succeed;
  double-review is rejected.
- **Status transitions**: All valid statuses are supported; already-reviewed
  appeals reject further transitions.
- **Provenance binding**: Digest and model version are bound to the
  recomputation; different versions produce different digests.
- **Evidence privacy**: Sensitive fields are stripped before persistence;
  serialized records do not leak PII.
- **Input validation**: Empty, short, and oversized reasons are rejected.
- **Admin queries**: Pagination and filtering work correctly.

```bash
npm test -- --testPathPattern="sybil-appeal-persistence" --no-coverage
```
