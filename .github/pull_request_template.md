## Linked task

Closes: <!-- exactly one active V2-BE issue -->
Head SHA reviewed: `<!-- full SHA -->`

## Summary

<!-- Explain the smallest cohesive backend change and its projection behavior. -->

## Scope and assignment

- [ ] The linked issue has the exact `Stellar Wave` label.
- [ ] The PR author is assigned or explicitly approved by a maintainer.
- [ ] This PR resolves one task and all dependencies are safely completed.

## Architecture and security

- [ ] Contracts/finalized events remain authoritative for protocol state.
- [ ] No backend-authoritative claim, vote, dispute, settlement, reward, treasury, or governance mutation was added.
- [ ] TypeORM/PostgreSQL remains the only persistence architecture; Prisma was not introduced.
- [ ] Reorg, duplicate delivery, retry, finality, stale-cache, and degraded-dependency behavior is fail-closed.
- [ ] SIWE/authentication, authorization, validation, redaction, and rate-limit impact was reviewed.
- [ ] No Stellar/Soroban/Freighter runtime, secret, placeholder production value, or production mock is included.

## Validation

- [ ] Lint, typecheck, and build pass.
- [ ] Unit and PostgreSQL integration tests pass.
- [ ] Migrations and rollback validation pass.
- [ ] Indexer/reorg and protocol-invariant tests pass.
- [ ] Security, container, and artifact-drift checks pass.
- [ ] Required human CODEOWNER approval applies to this exact head SHA.
