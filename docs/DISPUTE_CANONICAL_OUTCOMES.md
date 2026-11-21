# PREWAVE-BE-162 — Legacy dispute outcomes as canonical projections

The smart contract and finalized canonical events remain the only authority for
dispute outcomes. The legacy `DisputeService` is a **workflow read model plus an
explicit non-authoritative triage surface**; it can no longer settle, reject,
settle-bond, or expire a protocol dispute from an HTTP request.

## Authority boundary

| Field(s) | Who may write | Source |
| --- | --- | --- |
| `initiatorId` | Server only | Verified JWT principal (`request.user.address`) |
| `trigger`, `originalConfidence` | Server only | `DisputeRaised` canonical payload (otherwise `MANUAL` / `0`) |
| `status = RESOLVED / EXPIRED`, `outcome`, `finalConfidence`, `resolvedAt` | Server only | Finalized `DisputeResolved` / `DisputeExpired` canonical log |
| `chainId`, `deploymentAddress`, `artifactVersion`, `eventTxHash`, `eventLogIndex`, `eventBlockNumber` | Server only | Same canonical log |
| `recordKind`, `dataState` | Server only | `CANONICAL_PROJECTION` / `FINALIZED` vs `LEGACY_WORKFLOW` / `LOCAL_WORKFLOW` |
| `metadata.reviewTriage` | Moderator/admin | Explicitly non-authoritative review metadata |

Client-supplied `initiatorId`, `outcome`, `finalConfidence`, `rejectedBy`,
`trigger` and `originalConfidence` are not part of the HTTP schemas and are
ignored when present.

## Canonical evidence gate

`DisputeEvidenceService` fails closed. It resolves a caller-supplied log
pointer (`chainId`, `txHash`, `logIndex`) and rejects it unless **all** of the
following hold:

1. Chain is Optimism mainnet (`10`) or Sepolia (`11155420`) — `WRONG_CHAIN`.
2. The canonical event row exists with that exact log identity —
   `CANONICAL_EVENT_NOT_FOUND`.
3. The event name matches the expected `DisputeRaised` /
   `DisputeResolved` / `DisputeExpired` — `UNEXPECTED_EVENT_NAME`.
4. The deployment is registered and approved on that chain —
   `UNAPPROVED_DEPLOYMENT`.
5. The release artifact version matches the approved, checksum-verified
   artifact and exposes the event schema — `ARTIFACT_DRIFT` /
   `UNSUPPORTED_EVENT_SCHEMA`.
6. The event is not before the deployment block — `PRE_DEPLOYMENT_EVENT`.
7. A finalized checkpoint exists for the deployment and covers the event block,
   with a valid finalized block hash — `EVENT_NOT_FINALIZED` /
   `FINALIZED_BLOCK_HASH_MISSING`.
8. For a raise, the canonical `challenger` equals the verified principal —
   `CHALLENGER_MISMATCH`.
9. For a terminal event, `claimId`/`roundId` match the dispute's canonical
   binding — `DISPUTE_MISMATCH`.

## HTTP surface

- `POST /disputes` — authenticated. Creates a `LEGACY_WORKFLOW` /
  `LOCAL_WORKFLOW` record, or a `CANONICAL_PROJECTION` / `FINALIZED` record when
  a valid `canonicalEvent` raise log is supplied.
- `POST /disputes/:id/project-outcome` — moderator/admin. The **only** endpoint
  that writes terminal fields. Body contains just the canonical log pointer.
- `PATCH /disputes/:id/start-review` — moderator/admin. Workflow label only.
- `PATCH /disputes/:id/resolve` and `PATCH /disputes/:id/reject` — **deprecated**;
  they append `metadata.reviewTriage` entries and never change terminal fields.
- `GET /disputes/expired` — attention queue for stale workflow records, not an
  expiry authority.

## Reorg, replay and provenance

- `reconcileReorg(chainId, rollbackBlock)` clears terminal projections backed by
  events above the new head and demotes disputes whose raising event was
  reorged. No local terminal state survives without canonical support.
- `replayProjection(disputeId)` re-derives the newest finalized terminal event
  from the canonical history for the bound claim/round; if none is finalized it
  deterministically clears the terminal state.
- A unique partial index on `(chainId, eventTxHash, eventLogIndex)` makes
  duplicate/replayed logs deterministic.
- Every canonical row carries the full provenance tuple: chain, deployment,
  release artifact version, block, transaction and log index.

## Migration

`1793300000000-DisputeCanonicalOutcomes.ts` adds the provenance columns, labels
all pre-existing rows as non-authoritative, archives their locally-set outcome
under `metadata.legacyOutcome`, and clears the authoritative columns.
