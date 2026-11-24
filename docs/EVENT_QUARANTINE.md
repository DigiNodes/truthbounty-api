# Event Quarantine (PREWAVE-BE-053, #647)

Unknown, ABI-mismatched, malformed and undecodable contract logs are persisted
to `v2_event_quarantine` **before** any canonical event or projection write, so
a bad log can never mutate projections. Operators can review and replay them
against a corrected ABI.

## Classification

Each row records a coarse `reason` and a precise `failureKind`:

| `failureKind` | Meaning |
| --- | --- |
| `unregistered_address` | No artifact row for the contract address. |
| `abi_mismatch` | An approved artifact exists but fails checksum/ABI validation. |
| `unknown_topic` | `topic0` matches no fragment in the approved ABI. |
| `malformed_log` | Topics/data/txHash/blockNumber are structurally invalid. |
| `decoder_failure` | The ABI matched but decoding threw. |
| `artifact_drift` | Decoded, but the event has no canonical schema mapping. |

## Status and replay

`status` is `open` until a reviewed replay succeeds; only `open` rows block
readiness. Replay:

1. requires an admin identity (`super_admin`/`administrator`) and an
   `Idempotency-Key`;
2. clears the artifact cache and re-resolves the approved artifact, failing
   closed unless the caller-supplied `expectedArtifactVersion` matches;
3. re-runs the canonical ingest path (never a projection write directly);
4. rewinds every projector cursor that had passed the event, so it is
   re-consumed idempotently;
5. marks the row `replayed`, scrubs the retained raw payload, and writes an
   audit record.

A second replay of an already-replayed row is a no-op.

## Privacy

Reads never return the raw payload or free-form decoder detail. Rows retain a
bounded payload only while `open` (max 64 KiB); larger logs keep only
`dataHash` and `dataLength`. Replay scrubs the payload and detail entirely.
Readiness exposes only an aggregate count, never identifiers.

## API

Admin-plane (`JwtAuthGuard` + `AdminGuard` + `RolesGuard`):

| Method | Path | Roles |
| --- | --- | --- |
| `GET` | `/v2/admin/events/quarantine` | super_admin, administrator, security_analyst, auditor |
| `GET` | `/v2/admin/events/quarantine/:id` | same |
| `POST` | `/v2/admin/events/quarantine/:id/replay` | super_admin, administrator |

## Readiness

`GET /health/ready` fails closed while `getBlockingCount() > 0`. Replayed rows
no longer block, so resolving quarantine restores readiness.

## Retention

`EventQuarantineRetentionService` deletes **replayed** rows whose
`retentionUntil` has passed (`EVENT_QUARANTINE_RETENTION_DAYS`, default 90).
`open` rows are never deleted.
