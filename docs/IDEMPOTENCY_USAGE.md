# Idempotency usage

Idempotency keys protect API operations that the API is authorized to perform.
They do not grant the API authority to create protocol state.

## Claims and evidence

The legacy `POST /claims`, `POST /claims/:claimId/evidence`, and
`PUT /claims/evidence/:evidenceId` routes return `410 Gone`. They do not accept
idempotency keys, create local records, or mutate protocol projections.

Claim creation, evidence registration, and replacement must be submitted by
the user's wallet to the approved contract. Repeated wallet submissions are
handled by contract/event identity and the idempotent canonical projectors.
Clients should inspect the canonical read models after finality rather than
retry an API write:

- Claims: `GET /api/v2/claim-read-models` and
  `GET /api/v2/claim-read-models/:claimId`
- Evidence: `GET /v2/claims/:claimId/evidence`

An off-chain CID is only prepared content; it is not evidence registration.
This API currently exposes no claim-evidence upload endpoint.

## Other API operations

Continue using idempotency keys only for endpoints documented as supported
idempotent API writes, such as dispute creation. Follow the endpoint-specific
OpenAPI contract for required headers, retry policy, and error handling.
