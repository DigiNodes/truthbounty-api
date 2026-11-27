# Idempotency keys

Idempotency keys apply only to API operations that the API is authorized to
perform. They do not authorize protocol state transitions.

## Claims and evidence

The legacy `POST /claims`, `POST /claims/:claimId/evidence`, and
`PUT /claims/evidence/:evidenceId` routes return `410 Gone`, regardless of an
`Idempotency-Key` header. These endpoints do not create or mutate local
protocol-shaped rows.

Users submit claim creation and evidence registration/replacement directly
from their wallets to the approved contract. Transaction and event replay is
handled by contract identity and the idempotent canonical indexer/projector.
Clients must query the canonical projections after finality:

- Claims: `GET /api/v2/claim-read-models`
- Evidence: `GET /v2/claims/:claimId/evidence`

The API currently does not expose a claim-evidence upload endpoint. A CID
obtained from any off-chain preparation process is not evidence registration.

## Other operations

Use idempotency keys only where an active endpoint's OpenAPI contract
documents them, including `POST /disputes` where configured. Follow that
operation's documented key scope, retention, authorization, and retry behavior.
