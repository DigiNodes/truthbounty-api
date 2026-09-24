# Projection Readiness Gate (V2-BE-100)

## Why this exists

TruthBounty treats deployed Optimism/EVM contracts and their finalized canonical
events as the protocol authority. The API is a deterministic indexing,
projection, authentication, and delivery layer: it reproduces that authority, it
does not author it.

A projected read model is only a reproduction of protocol state if the API can
*prove* it is still current with the canonical event stream. Before this gate,
the V2 read endpoints (`/v2/claims/:id/evidence`, `/v2/claims/:id/verification-rounds`,
`/v2/claims/:id/disputes`) answered from whatever happened to be projected:
a stalled projector, a stream the projector had never consumed, or a batch of
logs it could not decode all produced a 200 response that looked exactly like
correct protocol state.

The gate makes that failure loud and actionable instead of silently wrong. When
readiness cannot be proven, the read path fails closed with `503` rather than
serving state the API cannot vouch for.

## Where it lives

| Artifact | Purpose |
| --- | --- |
| `src/v2/common/projection-readiness/projector-registry.ts` | Single source of truth for projector names and the canonical event names each projector consumes |
| `src/v2/common/projection-readiness/projection-readiness.types.ts` | Result contract (verdict, reasons, checks) |
| `src/v2/common/projection-readiness/projection-readiness.service.ts` | The gate: `evaluate`, `evaluateAll`, `assertReady` |
| `src/v2/common/projection-readiness/projection-readiness.controller.ts` | Read-only operator endpoint `GET /v2/projections/readiness[/:projector]` |
| `src/v2/common/projection-readiness/projection-readiness.module.ts` | Wiring; exported so V2 read paths can inject the gate |

The projectors themselves (`evidence-projector.service.ts`,
`verification-projector.service.ts`, `disputes-projector.service.ts`) import
their name and handled-event list from the registry, so the gate and the
projectors cannot drift apart about what a given projector is responsible for.

## Interfaces

```ts
// Fail-closed guard for read paths. Resolves only when the projection is
// provably caught up; otherwise throws ServiceUnavailableException (503).
assertReady(projector: V2ProjectorName): Promise<void>

// Total evaluation: never throws, always returns a verdict.
evaluate(projector: string): Promise<ProjectionReadiness>

// Every registered projector, plus an aggregate verdict.
evaluateAll(): Promise<ProjectionReadinessReport>
```

`ProjectionReadiness` carries the evidence behind the verdict, not just the
verdict: `cursor`, `canonicalHead`, `pendingEvents`, `quarantinedProtocolLogs`,
`quarantineThreshold`, machine-readable `reasons`, and one entry per invariant
`check` with a human-readable detail.

Failure body returned to callers (HTTP 503):

```json
{
  "statusCode": 503,
  "error": "projection_not_ready",
  "message": "Projection \"v2-evidence\" is not ready to serve protocol-derived reads: backlog",
  "projector": "v2-evidence",
  "reasons": ["backlog"],
  "pendingEvents": 4,
  "cursor": { "blockNumber": "899", "logIndex": 0 },
  "canonicalHead": { "blockNumber": "900", "logIndex": 0 },
  "checks": [{ "name": "projector_catch_up", "status": "fail", "detail": "4 canonical event(s) are not yet projected" }]
}
```

## Invariants

| Id | Invariant | Enforced by |
| --- | --- | --- |
| I1 | Evaluation is total. Any error while evaluating (dependency unreadable, malformed row, invalid configuration) is reported as `evaluation_error` with `ready: false`. | `evaluate` catch-all |
| I2 | Only registered projectors can be ready. An unknown name has no declared event contract, so nothing is asserted about it. | `isV2ProjectorName` |
| I3 | Canonical events for a projector imply a cursor. Events waiting with no cursor mean the projection may be empty or arbitrarily stale. | `projector_cursor_consistency` |
| I4 | The cursor never lags or leads the canonical stream. Behind = backlog; ahead = progress the canonical stream cannot substantiate. | `projector_catch_up` |
| I5 | Undecodable logs from an **approved** protocol contract block readiness: the projection is knowingly incomplete. Quarantine entries from unapproved addresses are not protocol state and do not block. | `protocol_log_quarantine` |

The gate never writes. It reads the canonical stream, the projector cursors, and
the quarantine table, so evaluating readiness can never advance, mutate, or
override protocol-derived state — including through a reorg.

Rows whose originating block cannot be established (legacy rows backfilled by
`1788100000000-AddBlockNumberToV2ProjectDispute`) are reported as `OBSERVED`;
finality is never asserted for data whose provenance is unknown.

## Failure modes and recovery

| Reason | Meaning | Operator action |
| --- | --- | --- |
| `evaluation_error` | The gate could not read a dependency (DB, cursor table, quarantine table) or the configuration is malformed. | Check database connectivity and migrations. Then check `PROJECTION_READINESS_QUARANTINE_MAX_PENDING` is a non-negative integer. Never treat this as ready. |
| `unknown_projector` | Something evaluated a projector name that is not in the registry. | Fix the caller; if a new projector was intended, register it in `projector-registry.ts` (name + handled events) in the same change that adds the projector. |
| `cursor_missing` | Canonical events exist for this projector but no cursor row was ever written. | Run the projector (`processNewEvents`) or restart the worker that schedules it. Verify the worker's DB credentials before assuming the projector is broken. |
| `backlog` | The cursor is behind the newest canonical event the projector must consume. | Let the projector drain (`pendingEvents` reports the exact remainder). If it does not decrease, inspect projector logs for a failing event; the projector is idempotent, so a retry after the fix is safe. |
| `cursor_ahead_of_stream` | The cursor claims progress the canonical stream does not contain: truncated history, a restored snapshot, or a manual cursor write. | Treat as an integrity incident. Rebuild the projection from canonical events (see below). Do not edit the cursor to make the gate pass. |
| `quarantine_backlog` | One or more logs from an approved contract address could not be decoded (unknown signature, artifact drift, decode error). | Inspect `v2_event_quarantine` for the offending `topic0`/`reason`. If the ABI is wrong, register the correct approved artifact and replay; if the event is genuinely unknown, reconcile the schema registry. Raising the allowance acknowledges a knowingly incomplete projection and must be a deliberate, documented decision. |

### Rebuild procedure (read model, not chain state)

1. Confirm the canonical events are intact: `SELECT count(*) FROM v2_canonical_events`.
2. Identify the affected projector and its projection tables.
3. Clear only that projector's projection tables and its row in
   `v2_projector_cursors`.
4. Re-run the projector over the canonical stream. It replays in
   `(blockNumber, logIndex)` order and is idempotent, guarded by unique
   constraints on the projector's own tables.
5. Confirm `GET /v2/projections/readiness` returns `ready` before re-enabling
   traffic to the affected read paths.

Protocol state is never rebuilt from the API side: the contracts and their
finalized events remain the only authority, and this procedure only re-derives
the read model from them.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROJECTION_READINESS_QUARANTINE_MAX_PENDING` | `0` | How many undecodable logs from approved protocol contracts are tolerated before the projection is considered not ready. `0` is the strict default: a projection missing events it should have decoded is not authoritative. A malformed value fails closed as `evaluation_error`; it is never widened implicitly. |

## Observability

- `GET /v2/projections/readiness` — aggregate verdict; `200` when every
  projector is ready, `503` with the full report otherwise. Public like the
  health probes, and deliberately sanitized: chain coordinates, counts, and
  invariant names only — no claim content, user data, RPC URLs, or credentials.
- `GET /v2/projections/readiness/:projector` — single projector; `400` for an
  unknown name, `503` when it is not ready.
- Read endpoints return `503` with `error: "projection_not_ready"` and the
  failing reasons, so an alert on that code identifies exactly which projection
  is behind and why. This is the intended failure signal: there is no fallback
  response that could be mistaken for protocol state.

## Tests

| Suite | Coverage |
| --- | --- |
| `projection-readiness.service.spec.ts` | Success, empty stream, unknown projector, missing cursor, backlog, cursor-ahead, quarantine allowance (default, widened, malformed, negative), unreadable dependency, malformed cursor coordinate, aggregate verdict, `assertReady` 503 payload |
| `projection-readiness.integration.spec.ts` | SQLite/TypeORM: caught-up, backlog, missing cursor, per-projector event scoping, approved-contract quarantine, unapproved-address quarantine (precision), degraded dependency, `assertReady` response, `evaluateAll` mixed verdict |
| `projection-readiness.controller.spec.ts` | GET-only surface, delegation, 503 on not ready, 400 on unknown projector |
| `evidence/verification/disputes-projector.service.integration.spec.ts` | Regression: each read path fails closed (503) when its projection is behind canonical events |

## Non-goals

This gate does not change protocol rules, does not add non-EVM runtime paths,
does not introduce backend-authoritative settlement/rewards/treasury/governance/
claim/dispute mutation, and does not replace the TypeORM persistence boundary.
It adds no new table: every input already exists in the V2 schema.
