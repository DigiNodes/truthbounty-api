# Governor proposal hash in the V2 governance projection

`GovernanceProjectionService.projectProposalCreated()` never stores the raw
`descriptionHash` as `proposalHash`. The two values are distinct on chain:

- `descriptionHash` — the `bytes32` description hash carried by the
  `ProposalCreated` event.
- `proposalHash` — the Governor's proposal id:
  `keccak256(abi.encode(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash))`.

The implementation lives in `ProposalDecoderService.computeProposalHash()` and
`verifyProposalHash()` and uses the canonical ABI encoding for the approved
OpenZeppelin-Governor-style release (`OZ_GOVERNOR_DESCRIPTION_HASH_V1`).

## Fail-closed rules

A `ProposalCreated` event is projected only when all of the following hold:

- the governor deployment is an approved artifact for the event's chain and its
  artifact version matches the version recorded on the event;
- `targets`, `values` and `calldatas` are present, non-empty and have equal
  lengths;
- each target is a 20-byte hex address, each value is a non-negative decimal
  string, each calldata is even-length `0x`-prefixed hex (raw bytes, hashed as
  `bytes[]`), and `descriptionHash` is 32-byte hex;
- the computed hash equals the `proposalId` emitted by the contract.

Any violation leaves the proposal unprojected and the event is counted as
`staleArtifact` instead of persisting a substituted hash. Cross-checking the
computed hash against the emitted `proposalId` also prevents a hash formula or
ABI from a different Governor release from being silently accepted.

## Stored and served fields

`v2_governance_proposals` stores `proposalHash`, `descriptionHash` and
`proposalHashScheme`. Chain, governor deployment, artifact version and the
originating `(txHash, logIndex)` remain on the same row as provenance.

`GET /v2/governance/proposals/:proposalId?chainId=<id>` returns `proposalHash`
and the separate `descriptionHash` / `proposalHashScheme` fields.

Migration `1793400000000` moves legacy rows that stored a description hash in
`proposalHash` into `descriptionHash` and blanks `proposalHash`. Reproject the
canonical `ProposalCreated` events to restore correct hashes for those rows.
