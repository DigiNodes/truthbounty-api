# Governance records: verified identity and canonical evidence (PREWAVE-BE-161)

The legacy `/governance` HTTP surface is an **off-chain draft + read-model API**.
It is not a transaction-submission endpoint and it does not execute governance.
The smart contract remains the source of protocol truth.

## Request contract

- `POST /governance/proposals`
  - The proposer is always `request.user.address` from the verified JWT principal.
    `dto.proposer` no longer exists; a body-supplied address cannot be persisted.
  - Without `canonicalEvent`, the row is `recordKind = OFFCHAIN_DRAFT`,
    `dataState = DRAFT`, `status = PENDING`. It is not a protocol proposal.
  - With `canonicalEvent = { chainId, txHash, logIndex }`, the service resolves a
    canonical `ProposalCreated` log and projects a chain-bound row
    (`CANONICAL` / `FINALIZED`). The event proposer must equal the principal.
- `POST /governance/proposals/:id/votes`
  - The body only carries `canonicalEvent` (+ optional metadata). `voter`,
    `support`, `weight` and `blockchainTxHash` are not accepted from clients.
  - Voter, support mode, exact uint256 weight, deployment, chain, artifact
    version and log identity are re-derived from a finalized `VoteCast` log.
  - Only a canonical proposal can receive a projected vote. Drafts cannot be
    activated, executed or voted on as protocol proposals.

## Fail-closed evidence gate

`GovernanceEvidenceService` rejects a request with a stable code when:

- the chain is not an approved Optimism chain (`10`, `11155420`) → `WRONG_CHAIN`;
- the `(chainId, txHash, logIndex)` log does not exist in `v2_canonical_events`
  → `CANONICAL_EVENT_NOT_FOUND` (a reorged log disappears the same way);
- the event name is not the expected one → `UNEXPECTED_EVENT_NAME`;
- the deployment has no approved, checksum-verified artifact →
  `UNAPPROVED_DEPLOYMENT` / `ARTIFACT_DRIFT`;
- the ABI does not define the event → `UNSUPPORTED_EVENT_SCHEMA`;
- the log predates the artifact's deployment block → `PRE_DEPLOYMENT_EVENT`;
- no finalized checkpoint covers the log block, or its finalized block hash is
  missing → `FINALIZED_CHECKPOINT_MISSING` / `EVENT_NOT_FINALIZED` /
  `FINALIZED_BLOCK_HASH_MISSING`;
- the event's proposer/voter does not match the verified principal, or its
  proposal id does not match the target → `PROPOSER_MISMATCH` / `VOTER_MISMATCH`
  / `PROPOSAL_MISMATCH`.

Vote uniqueness is keyed by
`(chainId, governorAddress, canonicalProposalId, voter, txHash, logIndex)`,
not by a bare address string. Replays are no-ops; a different log for the same
voter is rejected.

## Totals and reorgs

`rebuildProposalTotals()` recomputes counts and exact weight sums from the
canonical vote rows; `rebuildAllProposalTotals()` is idempotent and yields the
same result on every run. `reconcileReorg(chainId, block)` deletes projections
above the new canonical head, demotes reorged proposal rows back to drafts and
recomputes affected totals. No local path increments totals from client input.
