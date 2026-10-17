# Canonical Finalized-Block Ingestion Cursor (PREWAVE-BE-001)

```src/indexer/finalized-cursor/```
 persists one monotonic cursor per
`(chain_id, release_id)k in `v2_finalized_cursors`
(migration `1725000002000-CreateV2FinalizedCursors`).

## Boundaries

| Column | Source |
| --- | --- |
| `observed_head` | provider `latest` |
| `safe_head` | provider `safe` |
| `finalized_head` | provider `finalized` |
| `indexed_watermark` | highest finalized block whose projection effects are committed |

Each row is bound to the release `deployment_block` and `artifact_checksum`.
Any call whose binding differs fails with `WRONG_RELEASE`.

## Guarantees

- **Monotonic.** Heads that would move backwards (a lagging provider) are
  rejected with `PROVIDER_LAG`; the stored heads and `heads_observed_at` stay
  unchanged, so freshness decays and readiness fails closed.
- **Finalized only.** A range can never end past `finalized_head` (`NOT_FINALIZED`).
- **No gaps or duplicates.** A range must start at `indexed_watermark + 1`
  (`GAP`). A range at or below the watermark is a no-op (`duplicate`), and a
  partial overlap is rejected (`OVERLAP`). Events must be in canonical
  `(block, logIndex)` order (`OUT_OF_ORDER`, `DUPLICATE_EVENT`).
- **Atomic.** `applyFinalizedRange` runs projection effects and the
  watermark compare-and-set in one transaction (`SELECT … FOR UPDATE`).
  A crash at any step rolls back both, and a restart resumes from the last
  committed watermark.

## Readiness and metrics

Once a binding is configured,  `/health/ready` gains a critical
`finalized_cursor` check that fails on `CURSOR_MISSING`, `WRONG_RELEASE`,
`HEADS_NEVER_OBSERVED`, `HEADS_STALE` or `INDEX_LAG_EXCEEDED`.

Prometheus gauges are labelled only by `chain_id`, `release_id` and a fixed
`boundary` or `kind`:

-  indexer_finalized_cursor_block{boundary="observed|safe|finalized|indexed"}
-  indexer_finalized_cursor_lag_blocks_blocks`k{kind="finality|index"}
- `indexer_finalized_cursor_head_age_seconds`
- `indexer_finalized_cursor_ready`

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
```

The cursor suite covers tampering, replay across endpoints, filter change,
expiry, key rotation (including the bounded previous key), malformed base64,
and large-offset positions.

```bash
OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io  nzx jest finalized-cursor.op-sepolia
```

The Optimism Sepolia integration test is skipped unless `OP_SEPOLIA_RPC_URL` is set.
