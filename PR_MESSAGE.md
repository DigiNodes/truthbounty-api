# PR Summary

## Fix: Claims / Aggregation service audit issue

This PR resolves the audit-identified issue in the claims/aggregation area by correcting the Claims service implementation and ensuring the relevant unit tests pass.

### What changed
- Fixed malformed duplicate logic in `src/claims/claims.service.ts`
- Ensured optional claim fields (`source`, `metadata`) are normalized to `null` on create
- Updated tests to align with actual service constructor dependencies

### Verification
- Verified with targeted unit tests:
  - `src/claims/claims.service.spec.ts`
  - `src/claims/claim-resolution.service.spec.ts`
  - `src/aggregation/aggregation.spec.ts`

### Closes
- Closes #193
