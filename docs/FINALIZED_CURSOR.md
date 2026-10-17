# Canonical Finalized-Block Ingestion Cursor (PREWAVE-BE-001)

`_src/indexer/finalized-cursor/` persists one monotonic cursor per
``(chain_id, release_id, projection_id)`` in `v2_finalized_cursors`
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

- `indexer_finalized_cursor_block{boundary="observed|safe|finalized|indexed"}`
- `indexer_finalized_cursor_lag_blocks{kind="finality|index"}`
- `indexer_finalized_cursor_head_age_seconds`
