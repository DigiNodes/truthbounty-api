# Projection Readiness Gate (V2-BE-100)

`GET /v2/projections/readiness` answers one question: may a client treat the V2
read models as complete? It is a read-only, derived gate — it never writes,
settles, or invents protocol state.

## Contract

| Result | Meaning |
| --- | --- |
| `200` | At least one projector is tracked and **every** tracked projector is `healthy`. |
| `503` | At least one projector blocks readiness. The body is the gate report. |

```json
{
  "ready": false,
  "timestamp": "2026-11-19T10:00:00.000Z",
  "blockers": [
    {
      "projectorName": "v2-evidence",
      "status": "degraded",
      "dataState": "stale",
      "reason": "cursor-missing; indexer-degraded"
    }
  ]
}
```

## Fail-closed rules

- `degraded`, `unhealthy` and unknown projectors all block readiness.
- No cursor, missing checkpoints, an unavailable indexer snapshot or a stale
  safe/finalized height is never reported as ready.
- Recovery requires the next freshness evaluation to report `healthy`; an older
  success does not clear a current blocker.

## Sources

The gate is built from the same inputs as `GET /v2/projections/freshness`:

1. `v2_projector_cursors` — durable per-projector progress.
2. `v2_event_checkpoints` — safe/finalized heights.
3. `BlockchainStateService.getIndexerHealth()` — observed head and fallbacks.

## Operations

- Alert on `ready: false` persisting beyond one freshness window rather than on
  a single 503.
- Use `GET /v2/projections/freshness/:projectorName` to drill into the blocking
  projector named in `blockers[]`.
- Replaying or rebuilding a projector is safe; the gate re-evaluates on every
  request and holds no cached state.
