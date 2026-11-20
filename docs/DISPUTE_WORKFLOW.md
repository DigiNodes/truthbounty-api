# Legacy disputes: workflow and finalized projections

Issue #865 follows the maintainer's Prisma/PostgreSQL decision in #831. The older
TypeORM contribution guidance and PR checkbox conflict with that decision. This
change uses Prisma for the new workflow table and does not register the legacy
`Dispute` TypeORM entity. It does not migrate unrelated modules.

## HTTP contract

- `POST /disputes` accepts only `claimId` and optional `metadata`. The verified JWT
  principal's wallet becomes `initiatorAddress`. This requests review; it does not
  open an on-chain dispute. Client trigger, confidence, initiator and outcome fields
  receive 400. Nested metadata is untrusted and never used as protocol input.
- `PATCH /disputes/:id/start-review` and `PATCH /disputes/:id/review` require a
  moderator/admin. Review accepts `status` (`REVIEWING`, `ACCEPTED_FOR_REVIEW`, or
  `DISMISSED`) and optional `reason`. Replies label the `workflow` object with
  `authority: non_authoritative_workflow`. Dismissal has no protocol effect.
- Legacy `resolve` and `reject` routes return 410, including for administrators.
  Internal `expireDispute` also refuses local expiry. Clients must stop sending
  terminal commands and submit any protocol transaction to the contract.
- GET routes return an envelope containing `release`, `finalized`, and `items`.
  Claim detail additionally returns separate `workflows`. No old local status,
  confidence, outcome, or timestamp is promoted to protocol evidence. The legacy
  table remains untouched for archival purposes but is not queried by this module.

## Source and operational prerequisites

Set all of these server-side values from the approved deployed release, never from
a request: `CHAIN_ID` (10 or 11155420),
`CONTRACT_RELEASE_ID`, `DISPUTE_PROJECTION_CONTRACT_ADDRESS`,
`CONTRACT_RELEASE_DEPLOYMENT_BLOCK`, `DISPUTE_PROJECTION_DECODER_VERSION`, and
`RPC_URL`. Missing binding or unavailable finality fails closed with 503. The
operator must pin the decoder version to the approved ABI; the reader does not
decode arbitrary HTTP payloads or guess ABI field names.

The existing approved-decoder/indexer integration must persist `ChainEvent` rows
with that release and decoder version. `ChainEventDedupService.ingest` now requires
both fields for dispute events and persists the canonical identity key. Historical
unbound rows are excluded: reingest them with the approved decoder, rather than
assigning provenance to unverifiable data. No new public ingestion endpoint exists.

Reads select the scoped journal, ask RPC for the actual `finalized` block, verify
the RPC chain, and match every eligible event's block hash against the canonical
block at that height. They recheck the pinned finalized hash before publishing.
This intentionally does not trust the legacy event-height-derived checkpoint.
RPC or journal failures return 503 without partial outcomes or provider details.

`DisputeRaised`, `DisputeResolved`, and `DisputeExpired` are replayed in numeric
block/log order. Exact duplicates are harmless; conflicting duplicates and
impossible transitions fail closed. Each applied event contributes chain,
deployment, release, decoder, block number/hash and transaction/log provenance.
Confidence, deadlines, settlement, and bond disposition are copied only when the
approved event payload supplies them; absent fields stay null. Expiry alone never
implies refund, settlement, or a locally calculated deadline.

There is no separately persisted terminal cache. Removing a journal event or
changing its canonical block hash removes its effect on the next read; replaying
the winning history rebuilds the same view. Workflow records survive independently
and cannot restore a terminal state. Finalized RPC and complete journal history
are availability dependencies. Reads are bounded to 10,000 scoped event rows;
larger histories return 503, requiring a separately designed persisted projector
before raising this bound. This tradeoff favors correctness over read latency.

## Database and rollout

Apply `prisma/migrations/20261120140000_dispute_workflow/migration.sql` only to the
canonical PostgreSQL database through the repaired Prisma migration baseline.
The migration creates workflow metadata only; it never copies legacy outcomes.
The matching model is in `schema.prisma`. Rollback SQL is in
`docs/runbooks/dispute-workflow-rollback.sql`; export workflow records before using
it, and keep retired terminal writers disabled.

At the issue base, package.json is malformed, schema.prisma contains a duplicate
BlockCursor field, the migration lock still says SQLite, and PrismaService still
uses LibSQL. These are maintainer-owned #831 baseline problems. This contribution
does not claim that full application startup or the full migration chain works
until that baseline is repaired. Deploy only after its checks pass.
