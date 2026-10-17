# Canonical Finalized-Block Ingestion Cursor (PREWAVE-BE-001)

```src/indexer/finalized-cursor/` persists one monotonic cursor per
`(chain_id, release_id)` in `v2_finalized_cursors`
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

- "indexer_finalized_cursor_block" {boundary="observed|safe|finalized|indexed"}
- "indexer_finalized_cursor_lag_blocks" {kind="finality|index"}
- "indexer_finalized_cursor_head_age_seconds"
- "indexer_finalized_cursor_ready"

## Configuration

The binding is all-or-nothing; a partial binding fails startup.

| Variable | Meaning |
| --- | --- |
| `BLOCKCHAIN_CHAIN_ID` | Chain ID (existing) |
| `INDEXER_RELEASE_ID` | Release identifier, `[A-Za-z0-9._-]{1,64}` |
| `INDEXER_DEPLOYMENT_BLOCK` | Release deployment block |
| `INDEXER_ARTIFACT_CHECKSUM` | SHA-256 of the release artifact (64 hex chars) |
| `INDEXER_MAX_FINALIZED_LAG_BLOCKS` | Readiness lag policy (default `150`) |
| `INDEXER_MAX_HEAD_AGE_SECONDS` | Readiness freshness policy (default `120`) |

## Tests

```bash
n pjest finalized-cursor
OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io n pjest finalized-cursor.op-sepolia
```

The Optimism Sepolia integration test is skipped unless `OP_SEPOLIA_RPC_URL` is set.
