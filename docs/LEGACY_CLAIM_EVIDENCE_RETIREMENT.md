# PREWAVE-BE-132 — Retirement of API-authoritative claim and evidence writes

Status: implemented (issue #835). Supersedes the legacy `POST /claims`,
`POST /claims/:claimId/evidence` and `PUT /claims/evidence/:evidenceId`
workflow described in older documents.

## Authority boundary

Optimism/EVM contracts and finalized canonical events are the only authority
for protocol state. The API is a non-authoritative indexer/projection and
support layer:

- It **never** creates a claim, verdict, finalization, evidence registration,
  evidence version or evidence removal.
- It **may** validate content, scan it for secrets, upload/pin it on IPFS, and
  return a preparation receipt that explicitly says no registration occurred.
- It **serves** reads from V2 projections (`/api/v2/claims`,
  `/api/v2/claim-read-models`, `/v2/claims/:claimId/evidence`).

## Chain-first lifecycle

1. **Prepare (optional, API-owned):** `POST /claims/:claimId/evidence/upload`
   pins content on IPFS for a claim that is *already present in the canonical
   projection*. It returns `status: IPFS_CONTENT_PREPARED`,
   `onChainRegistered: false`, `evidenceRegistered: false`, `canonical: false`.
2. **Submit (wallet-owned):** the user signs and sends a `ClaimCreated`,
   `EvidenceRegistered`, `EvidenceReplaced` or `EvidenceRemoved` transaction.
   The API does not relay or pay for it.
3. **Index (indexer-owned):** the finalized event is ingested as a canonical
   event and projected by `EvidenceProjectorService` / the claim projector.
4. **Read (API-owned):** clients poll the V2 projection endpoints. A claim or
   evidence item is canonical only after step 3. Pending, quarantined, reorged
   and unknown events expose `NOT_FOUND` / `STALE_RECONCILIATION`, never a
   locally synthesized row.

## Route changes (OpenAPI / authorization)

| Method | Route | Previous | Now |
|--------|-------|----------|-----|
| POST | `/claims` | AUTHN, inserted a `Claim` row | `410 Gone`, `LEGACY_PROTOCOL_WRITE_RETIRED`, `operation: claim.create` |
| POST | `/claims/:claimId/evidence` | AUTHN, inserted `Evidence` + v1 | `410 Gone`, `operation: evidence.register` |
| PUT | `/claims/evidence/:evidenceId` | AUTHN, inserted a new version | `410 Gone`, `operation: evidence.replace` |
| POST | `/claims/:claimId/evidence/upload` | — | AUTHN, non-authoritative IPFS preparation (`202 Accepted`) |
| GET | `/claims/...` (legacy reads) | unmarked | same response plus `Deprecation: true` and `Link` to V2; marked `deprecated` in OpenAPI |

The 410 body is stable and machine-readable:

```json
{
  "statusCode": 410,
  "error": "Gone",
  "code": "LEGACY_PROTOCOL_WRITE_RETIRED",
  "operation": "evidence.register",
  "message": "Legacy API-authoritative protocol writes are retired. ...",
  "replacement": "... user-signed EvidenceRegistered transaction ...",
  "lifecycle": ["..."],
  "canonical": false
}
```

No route or internal service method writes a protocol-shaped row before
throwing: `ClaimsService.createClaim`, `EvidenceService.createEvidence` and
`EvidenceService.addEvidenceVersion` are fail-closed seams that call the same
guard. No `@AuditLog`, cache invalidation, IPFS or repository call runs on a
retired write.

## Frontend integration guidance

- Replace claim/evidence creation forms with wallet transaction signing
  (contract call), then poll `GET /api/v2/claim-read-models/:claimId` and
  `GET /v2/claims/:claimId/evidence` until the projected state is visible.
- Treat `202` from the upload endpoint as "content pinned", **not** "evidence
  submitted". Never render a success state for on-chain registration from this
  response; display the transaction hash only after the wallet confirms it.
- Handle `410 LEGACY_PROTOCOL_WRITE_RETIRED` by showing the chain-first steps
  and a deep link to the V2 read endpoint; do not retry with another payload.
- Handle `404`/`503` on V2 reads as pending: delayed, quarantined or reorged
  events are not yet canonical.
- Repeat uploads of the same content are deterministic (`preparationId` is
  derived from `claimId` and CID); deduplicate on the client by that id.

## Retirement / migration plan for legacy state

No destructive migration is performed in this change and no TypeORM migration
or persistence change is introduced (Prisma/PostgreSQL remains the single
authority for domain persistence).

1. **Freeze:** retired routes and service methods now fail closed, so no new
   legacy `claims`, `evidences` or `evidence_versions` rows can be created.
2. **Inventory (before any deletion):** record row counts, cache keys
   (`claims:*`) and audit `CLAIM_CREATED` / `EVIDENCE_SUBMITTED` /
   `EVIDENCE_UPDATED` entries; keep them as historical, non-authoritative data.
3. **Read routing:** new consumers use V2 projections. Legacy GETs remain
   available during the deprecation window with explicit deprecation headers.
4. **Reconciliation (separate approved change):** compare each legacy row with
   the V2 projection by canonical claim id; discrepancies are logged, never
   backfilled into canonical projections.
5. **Sunset:** after consumer migration and maintainer approval, remove the
   legacy tables, repositories, cache keys and admin views in a reviewed
   migration. Until then they are read-only archaeology.
6. **Seeding/dev data:** local seed scripts that fabricate verdicts or evidence
   are not a production writer and must not be used to validate the chain-first
   lifecycle; use canonical event fixtures/replay instead.

## Operational checks

- Replay/idempotency: the projector's `(evidenceId, version)` uniqueness and
  `ProjectorCursor` checkpoint make duplicate event delivery a no-op; upload
  preparation is content-addressed and stateless.
- Reorg/quarantine: without a finalized canonical event the V2 read models stay
  absent or stale and fail closed; the API cannot fill the gap with a local row.
- Tests: `src/claims/legacy-protocol-write-retirement.spec.ts` and
  `src/claims/evidence-upload/evidence-upload-preparation.service.spec.ts`
  cover the 410 envelope, no-side-effect invariant, canonical identity gate,
  secret handling, non-authoritative receipts and duplicate uploads.
