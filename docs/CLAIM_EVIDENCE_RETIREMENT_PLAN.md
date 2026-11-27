# Legacy claim and evidence retirement plan

## Authority boundary

Claims, votes, evidence registration, and evidence replacement are protocol
transitions. Users submit them from their wallets to the approved contract.
The API indexes finalized canonical events and serves rebuildable V2 read
models; it must not synthesize protocol state from HTTP requests or legacy
TypeORM rows.

## Current compatibility behavior

| Surface | Current behavior | Canonical replacement |
| --- | --- | --- |
| `POST /claims` | `410 Gone`; does not persist a claim | Wallet transaction, then `/api/v2/claim-read-models` |
| `POST /claims/:claimId/evidence` | `410 Gone`; does not register evidence | Wallet transaction, then `/v2/claims/:claimId/evidence` |
| `PUT /claims/evidence/:evidenceId` | `410 Gone`; does not replace evidence | Wallet transaction, then canonical evidence projection |
| Legacy `/claims` and `/evidence` reads | `410 Gone`; legacy rows are not presented as canonical | V2 projection query endpoints |
| Legacy lifecycle and claim-feed endpoints | `410 Gone` and not wired to the TypeORM-backed services | Canonical V2 projection endpoints |
| Claim search | Legacy claim rows omitted; entity-specific legacy claim search is gone | Canonical claim query service when supported |
| `ProjectionClaimSearchService` | Removed; it was unused and read legacy TypeORM claims despite its projection-only name | V2 read-model queries only |
| Dashboard claim metrics | Read from `ClaimReadModel`, not the legacy `Claim` entity | Canonical projected state |
| Claim/evidence upload preparation | No dedicated claim-evidence upload route is exposed | Any future upload must remain non-authoritative and separately reviewed |

Moderation flagging and secret-quarantine administration are separate
operations and remain subject to their existing access controls and audit
requirements. They do not register or replace evidence.

## Historical data and retirement gates

No legacy `Claim`, `Evidence`, or `EvidenceVersion` table, cache, audit record,
or historical row is dropped, backfilled, or rewritten by this change. The
legacy entity schemas remain only for compatibility with existing deployed
data and narrowly scoped moderation behavior. Production claim/evidence reads
must not use them as protocol state.

Before any physical schema/data retirement, maintainers must:

1. Inventory deployed consumers, caches, audit/reporting dependencies, and
   retention obligations using deployment evidence, not source search alone.
2. Compare legacy rows with canonical indexed events/read models, recording
   unmatched, duplicate, quarantined, delayed, and reorg-affected records.
3. Propose a reversible migration and retention/export strategy, including
   operator verification and rollback steps.
4. Obtain maintainer approval and schedule the migration independently from
   this authority-boundary change.
5. Remove the legacy entities and migrations only after all consumers have
   migrated and the approved retention period has elapsed.

Until those gates are approved, preserve historical data unchanged. No
TypeORM schema migration or Prisma/PostgreSQL ownership change is part of this
retirement plan.
