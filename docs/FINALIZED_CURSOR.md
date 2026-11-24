# Canonical Finalized-Block Ingestion Cursor (PREWAVE-BE-001)

`src/indexer/finalized-cursor/` persists one monotonic cursor per
`(chain_id, release_id, projection_id)` in `v2_finalized_cursors`
(migration `1725000002000-CreateV2FinalizedCursors`).

## Boundaries

| Column | Source |
| --- | --- |
| `observed_head` | provider `latest` |
| `safe_head` | provider `safe` |
| `finalized_head` | provider `finalized` |
| `indexed_watermark` | highest finalized block whose projection effects are committed |
| `block_hash` | canonical hash of the block at `indexed_watermark` |
| `checkpoint_provenance` | identifier of the checkpoint source that advanced the cursor |

Each row is bound to the release `deployment_block` and `artifact_checksum`.
Any call whose binding differs fails with `WRONG_RELEASE`. The cursor is also
bound to the chain ID (`identity.chainId`) and to a projection ID; a call that
targets a different chain or projection fails closed with `WRONG_BINDING`.

## Guarantees

- `advanceFinalizedCursor` advances the cursor with a single atomic
compare-and-swap guarded by `SELECT ... FOR UPDATE`. The update is conditional on the
observed `indexed_watermark` and `block_hash`; a concurrent writer that changed
either field fails the compare and the write is rejected with `STANE_WRITER`.
- `advanceFinalizedCursor` requires the new watermark to equal the current
watermark plus one and the new block hash to differ from the stored hash. Any
other relationship fails closed with `NON_MONOTONIC` or `HASH_DISAGREEMENT`.

The advance is atomic per `chain_id/release_id/projection_id`:
two competing writers cannot both advance the same cursor, and neither can skip
a range.

- `advanceFinalizedCursor` records the block hash, finalized head, deployment
  floor, and checkpoint provenance in the same transaction as the watermark
  advance, so a restart resumes from a fully described checkpoint.
- **Hash disagreement fails closed.** If the supplied block hash for the current
  watermark differs from the stored hash, the advance is rejected with
  `HASH_DISAGREEMENT` and no state is written.
- `rollbackFinalizedCursor` is the only path that can move the cursor
  backward. It requires an explicit authorization token (`authorization`)
  and a non-empty `auditReason`, records the rollback in the cursor row and
  the audit log, and fails closed with `UNAUTHORIZED_ROLLBACK` otherwise.
  Rollbacks are bound to the same chain/release/projection and cannot move
  the cursor below the deployment floor (`BELOW_DEPLOYMENT_FLOOR`).

## Readiness and metrics

Once a binding is configured,  `/health/ready` gains a critical
`finalized_cursor` check that fails on `CURSOR_MISSING`, `WRONG_RELEASE`,
`HEADS_NEVER_OBSERVED`, `HEADS_STALE` or `INDEX_LAG_EXCEEDED`.

Prometheus gauges are labelled only by `chain_id`, `release_id`, `projection_id` and a fixed
`boundary` or `kind`:

- "indexer_finalized_cursor_block" {boundary="observed|safe|finalized|indexed"}
- "indexer_finalized_cursor_lag_blocks" {kind="finality|index"}
- "indexer_finalized_cursor_head_age_seconds"
- "indexer_finalized_cursor_ready"

## Configuration

The binding is all-or-nothing; a partial binding fails startup.

| Variable | Meaning |
| --- | --- |
| `BLOCKCHAIN_CHAIN_ID` | Chain ID| (existing) |
| `INDEXER_RELEASE_ID` | Release identifier, `[A-Za-z0-9._-]{1,64}` |
| `INDEXER_DEPLOYMENT_BLOCK` | Release deployment block |
| `INDEXER_ARTIFACT_CHECKSUM` | SHA-256 of the release artifact (64 hex chars) |
| `INDEXER_MAX_FINALIZED_LAG_BLOCKS` | Readiness lag policy (default `150`) |
| `INDEXER_MAX_HEAD_AGE_SECONDS` | Readiness freshness policy (default `120`) |

## Opaque pagination cursors (PREWAVE-BE-040)

List endpoints that page over finalized ranges expose an opaque,
signed cursor rather than a client-editable payload. Clients treat the
cursor as an opaque token and MUST NOT attempt to parse or construct one.

### Encoding

The cursor is `<base64url(payload)>.<base64url(HMAC)>`. The payload is
canonical JSON (sorted keys, no insignificant whitespace). The HMAC is
HMAC-SHA256 over the raw payload bytes, keyed by the cursor signing key.
Both segments use base64url without padding.

### Payload claims

Every cursor binds the following claims; mismatch on any of them is a
fail-closed rejection.

| Claim | Meaning |
| --- | --- |
| `v#` | Cursor schema version (currently `1`) |
| `route` | Canonical route/schema identifier of the endpoint |
| `chain_id` | Chain ID the cursor was issued for |
| `release_id` | Release identifier |
| `deployment_block` | Release deployment block |
| `artifact_checksum` | Release artifact SHA-256 |
| `filters` | Canonical filter set (normalized) |
| `sort` | Sort order and tie-justification |
| `position` | Last consumed `(block, logIndex)` or id key |
| `iat` | Issuance timestamp (seconds) |
| `exp` | Expiry timestamp (seconds) |
| `kid` | Signing key identifier (for rotation) |

### Validation

On every request the server verifies the HMAC, then checks that:

- the payload is well-formed and the version is supported (`CURSOR_MALFORMED\`);
- the signing key is the current key or a bounded previous key (`CURSOR_KEY_UNKNOWN`);
- the cursor has not expired (`CURSOR_EXPIRED`);
- `chain_id`, `release_id`, `deployment_block` and `artifact_checksum` match the
  current binding (`WRONG_RELEASE`);
- `route` matches the endpoint being called (`CURSOR_WRONG_ROUTE`);
- `filters` and `sort` match the request (`CURSOR_FILTER_MISMATCH`).

Any failure is a client error (`INVALID_CURSOR`). Error bodies never echo the
payload, the HMAC, the key, or any signing material; they report only the
stable error code.

### Key rotation

Signing keys are identified by `kid`. Rotation promotes a new key and retains
at most one bounded previous key for verification. Cursors signed with a
previous key remain valid until their `exp` passes or the previous key is retired,
whichever comes first. Once retired, cursors signed with that key fail with
`CURSOR_KEY_UNKNOWN`.

### Stability under concurrent inserts

Cursors paginate over the canonical finalized ordering `(block, logIndex)`.
Because only finalized blocks are paginated and the position is a strict key,
concurrent inserts of newer blocks appear after the cursor position and do not
shift already-returned pages. A cursor whose position is ahead of the current
 `indexed_watermark` fails closed with `CURSOR_STALE`.

## Tests

```bash
n pjest finalized-cursor
OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io n pjest finalized-cursor.op-sepolia
```

The cursor suite covers tampering, replay across endpoints, filter change,
expiry, key rotation (including the bounded previous key), malformed base64,
and large-offset positions.

```bash
OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io  nzx jest finalized-cursor.op-sepolia
```

The Optimism Sepolia integration test is skipped unless `OP_SEPOLIA_RPC_URL` is set.