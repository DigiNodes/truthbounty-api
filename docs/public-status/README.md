# Public Service-Status Projection (UX-BE-001)

`GET /status/public` returns a sanitized, versioned (`public-status.v1`) status
projection for the public status page. It is unauthenticated, cached and rate
limited. The protected `/health/*` reports are unchanged and are **not** the
source of truth for the public page.

## Published artifacts

| File | Purpose |
| --- | --- |
| [`openapi.json`](./openapi.json) | OpenAPI 3 document for the endpoint and its DTOs |
| [`fixtures.json`](.fixtures.json) | Frontend fixtures, one per scenario (operational, unavailable, delayed, stale, wrong release, not configured) |

Both are verified against the code by
`src/health/public-status/public-status.artifacts.spec.ts`. Regenerate after a
schema change with:

```bash
UPDATE_PUBLIC_STATUS_ARTIFACTS=1 npx jest public-status.artifacts
```

## Schema

- `components[]`: `web`, `api`, `rpc`, `indexer`, `database`, `evidence_gateway`
- `release`: release ID, chain ID, deployment block, artifact checksum
- `chain`: finalized block, indexed block, lag in blocks
- `cache`: `maxAgeSeconds`, `staleAfterSeconds`, `expiresAt`

Every component, `release` and `chain` carries an `observation` with `source`,
`observedAt`, `ageSeconds` and `freshness` (`fresh` | `stale` | `unknown`).

States: `operational`, `degraded`, `delayed`, `stale`, `unavailable`, `unknown`.
`overall` is the worst state, in the order
operational < degraded < delayed < stale < unknown < unavailable.

## Fail-closed rules

- No observation → `unknown` (source `not_observed`). Never `operational`.
- Observation older than `staleAfterSeconds` → `stale`.
- Any failed dependency probe → `unavailable`, whatever its internal criticality.
- Finalized lag beyond policy → `delayed`.
- Cursor bound to a different release → `unavailable`, and no block numbers are published.

## Redaction

The response is built field-by-field from allow-listed DTOs
(`src/health/public-status/public-status.dto.ts`); nothing from internal
reports is spread or passed through. Hostnames, URLs, failure messages, stack
traces, response times, criticality, diagnostics and secrets never appear.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_STATUS_CACHE_TTL_SECONDS` | `15` | Server cache and `Cache-Control: max-age` |
| `PUBLIC_STATUS_STALE_AFTER_SECONDS` | `120` | Age after which observations are `stale` |
| `PUBLIC_STATUS_WEB_HEALTH_URL` | unset | Web frontend URL to probe; `web` is `unknown` when unset |
| `PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS` | `2000` | Web probe timeout |
| `PUBLIC_STATUS_RATE_LIMIT` | `60` | Requests per client IP per window |
| `PUBLIC_STATUS_RATE_WINDOW_SECONDS` | `60` | Rate limit window |

Chain, indexer, RPC and release data come from the finalized-block cursor
(PREWAVE-BE-001, see [`../FINALIZED_CURSOR.md`](../FINALIZED_CURSOR.md)); they
are `unknown` until a release binding is configured.

## Verifier Eligibility and Commit-Reveal Projections (PREWAVE-BE-006)

The public status projection also publishes the verifier eligibility and
commit-reveal phase projections for the Optimism Sepolia review path. These
projections are derived exclusively from contracts and finalized canonical events;
the service never invents protocol state.

### Verifier readiness and assignment

Each verifier entry exposes only contract-derived inputs:

- `readiness`: `unavailable` | `ineligible` | `stale` | `wrong_release` | `ready`
- `assignment`: assignment ID and review task ID, or `null` if unassigned
- `stake` and `reputation`: authoritative inputs with source references
- `effectiveWeight`: value plus `sources[]` referencing the contract and
  finalized events that produced it

Eligibility and deadline boundaries are evaluated against the canonical block
number and timestamp of the finalized cursor. A missing, stale, ambiguous or
wrong-release input fails closed to the corresponding non-ready state.

### Phase and deadline projection

Phase values (`commitment`, `reveal`, `settlement`) and deadline timestamps
come from canonical contract state. The projection reports the current phase,
the commitment deadline, the reveal deadline, and the completion status.
No deadline or phase value is derived from local clocks or client input.

### Commitment and reveal requirement

- `commitment`: whether a commitment has been recorded for the assignment
- `revealRequired`: whether a reveal is required before the reveal deadline
- `completion`: `pending` | `complete` | `missed_reveal` | `slashed` | `unavailable`

Before the canonical reveal, the projection must not leak protected votes,
rationale, or non-public evidence. Only the fact of a recorded commitment and
the reveal requirement are published.

### Separated failure states

The projection distinguishes four distinct non-ready states so clients can
react correctly:

| State | Meaning |
| --- | --- |
| `unavailable` | Contract or finalized event data could not be read |
| `ineligible` | Contract state declares the verifier ineligible |
| `stale` | Observation is older than the staleness policy |
| `wrong_release` | Data is bound to a different release ID |

All four fail closed: the verifier is never reported `ready` when any of these
conditions holds.

### Privacy and side-channel constraints

- Protected decisions cannot be inferred before canonical reveal.
- The projection never includes vote content, rationale, or non-public evidence.
- Timing, size, or ordering of commitments is not exposed beyond what canonical
  events already publish on-chain.
- Secrets, authorization material, and non-public evidence are never logged.

### Chain and release binding

All chain-derived data is bound to chain ID, release ID, deployment block,
and artifact checksum. Data that cannot be bound to the configured release is
published as `wrong_release` and fails closed.

## Frontend fixtures

Frontend fixtures cover the approved Batch 4 states and are verified against
the code alongside the status fixtures. Regenerate them with the same
command as the status artifacts.

## Required tests

- Eligibility boundary and deadline tests.
- Pre-reveal privacy and side-channel regression tests.
- Reorg, missed reveal, slashing, and finalized settlement projection tests.
