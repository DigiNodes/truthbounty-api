# Bugfix Requirements Document

## Introduction

The TruthBounty API's chain-ingestion layer contains several interconnected gaps that together allow the historical event index to become silently incomplete, stale, or inconsistent with canonical Optimism/EVM state. These gaps affect the `EventIndexerService` (the primary event-polling loop and backfill entry point), the interaction between the indexer and the `BlockchainStateService` health/observability layer, and the connection between contract deployment artifacts and the starting block of the backfill window.

The bugs do not cause a crash; they manifest as missing events, a divergent `lastProcessedBlockNumber` checkpoint, and silent dead-letter accumulation — all without any observable failure signal. Because TruthBounty treats the canonical chain as protocol authority, any indexing gap that is not surfaced and corrected represents unauthorized omission of protocol truth.

This document captures the current defective behavior, the correct behavior the system must exhibit after the fix, and the existing behavior that must be preserved unchanged.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the RPC provider rejects an `eth_getLogs` request because the requested block range exceeds the provider's maximum range limit THEN the system retries the entire original range with exponential backoff and eventually marks the indexing state as `error`, leaving the backfill stalled at the same block cursor

1.2 WHEN `backfillFromBlock` is called for a contract that has a large gap between the contract deployment block and the current finalized block THEN the system resets the cursor to the requested block and relies on the normal polling loop to close the gap one fixed-size batch at a time, with no mechanism to detect that the gap is too large for the standard polling cadence

1.3 WHEN the provider's `eth_getLogs` batch response returns zero events for a range THEN the system unconditionally advances `lastProcessedBlockNumber` to `endBlock`, even when `endBlock` was computed using a stale `currentBlockNumber` that is ahead of the provider's actual finalized block

1.4 WHEN an event fails processing past `maxRetryAttempts` THEN the system logs a warning but does not call `stateService.recordDeadLetter()`, so the dead-letter counter in the `IndexerHealthSnapshot` is never incremented and the `degraded` health threshold for dead letters is never triggered

1.5 WHEN the indexer advances the `lastProcessedBlockNumber` checkpoint for a batch THEN the checkpoint write occurs in a separate `stateRepository.save()` call after each individual event is written, rather than committing both atomically; if the process restarts between event saves and the checkpoint save, some events are persisted without the checkpoint advancing, causing duplicate delivery on the next startup

1.6 WHEN a backfill is initiated via `POST /indexer/backfill` THEN the system accepts any caller-supplied `blockNumber` as the backfill starting point without validating it against the canonical contract deployment block recorded in the approved `v2_contract_artifacts` artifact, allowing a backfill window that begins before or after the actual contract genesis

1.7 WHEN the indexer is performing a historical backfill over a range that is already past the provider's finalized block THEN the system applies the same `confirmationsRequired` threshold used for live tip processing, which is inappropriate for historical blocks that are already finalized and never reorg

1.8 WHEN `reconcileReorgs` runs against a large set of finalized events THEN the system loads all finalized events from the database into memory simultaneously with no pagination, which can exhaust available memory on a node with a large event history

### Expected Behavior (Correct)

2.1 WHEN the RPC provider rejects an `eth_getLogs` request with a range-too-large error THEN the system SHALL automatically halve the requested block range, retry the smaller range, and continue halving until the request succeeds or the range reaches a minimum floor of one block, recording a warning metric for each halving step and permanently reducing the effective batch size for subsequent batches in the same backfill pass

2.2 WHEN `backfillFromBlock` is called and the gap between the requested start block and the current finalized block exceeds a configurable `adaptiveFillThresholdBlocks` THEN the system SHALL enter a dedicated high-throughput backfill mode that issues batches as fast as the RPC provider allows rather than waiting for the standard polling interval, and SHALL emit a structured log event indicating that adaptive backfill mode is active

2.3 WHEN `endBlock` is computed for a batch THEN the system SHALL cap `endBlock` at the provider's current finalized block number (from `eth_getBlockByNumber("finalized")`) rather than at `currentBlockNumber - confirmationsRequired`, so the cursor never advances past canonical finality

2.4 WHEN an event fails processing past `maxRetryAttempts` THEN the system SHALL call `stateService.recordDeadLetter(1)` and SHALL set the event's status to a permanent `dead_letter` state in the indexing state record, so the dead-letter counter in `IndexerHealthSnapshot` reflects reality and operators are alerted at the configured threshold

2.5 WHEN the indexer commits a completed batch THEN the system SHALL write all event rows and the updated `lastProcessedBlockNumber` checkpoint in a single database transaction so that restarts are guaranteed to resume from a consistent state with no risk of duplicate event delivery or skipped blocks

2.6 WHEN `POST /indexer/backfill` is called THEN the system SHALL validate that the supplied `blockNumber` is greater than or equal to the deployment block recorded in `v2_contract_artifacts` for the given `contractAddress` and `chainId`, and SHALL reject the request with a `400` error and an explanatory message if the requested block predates the contract's canonical deployment block

2.7 WHEN the backfill cursor advances over blocks whose number is less than or equal to the provider's finalized block number THEN the system SHALL mark those events as `isFinalized = true` immediately upon ingestion, bypassing the live-tip confirmation count check, because finalized historical blocks are canonical by protocol definition and cannot reorg

2.8 WHEN `reconcileReorgs` queries for finalized events to check for reorg risk THEN the system SHALL apply a pagination limit (configurable, defaulting to 1000 rows per page) so that the reconciliation loop never loads the entire event history into memory in a single query

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a new event is received from the live chain tip and has fewer than `confirmationsRequired` confirmations THEN the system SHALL CONTINUE TO store it as `isFinalized = false` and defer finalization until the confirmation threshold is met

3.2 WHEN the same `(transactionHash, logIndex, eventType)` triple is received more than once THEN the system SHALL CONTINUE TO treat the second and subsequent deliveries as no-ops, preserving the idempotency guarantee at both the application and database-constraint levels

3.3 WHEN a previously finalized event's block falls below the confirmation threshold due to a chain reorg THEN the system SHALL CONTINUE TO mark it `isFinalized = false`, reset `isProcessed = false`, and clear `processingError` so it can be reprocessed against the canonical chain

3.4 WHEN an RPC call fails transiently THEN the system SHALL CONTINUE TO retry with exponential backoff via `withRpcBackoff`, increment the `rpcFailureCount` metric, and surface `degraded` health status when the failure rate exceeds the configured sliding-window threshold

3.5 WHEN the indexer is running normally at the chain tip THEN the system SHALL CONTINUE TO poll at the configured `pollingIntervalMs` interval, process events in `blockRangePerBatch`-sized batches, and update `lastProcessedBlockNumber` monotonically

3.6 WHEN the canonical events pipeline (`CanonicalEventsService.ingest`) processes a log THEN the system SHALL CONTINUE TO quarantine logs from unregistered addresses, unknown signatures, decode errors, and artifact drift without error propagation to the caller, and SHALL CONTINUE TO advance the `v2_event_checkpoints` cursor atomically with each successful ingestion

3.7 WHEN the `ReorgSafeCursorService.advanceCursorAtomically` writes a cursor advancement and projection updates THEN the system SHALL CONTINUE TO commit both in a single transaction and roll back both on error, preserving the atomic cursor-plus-projection guarantee

3.8 WHEN the `BlockchainIndexerService` processes a `Transfer` event THEN the system SHALL CONTINUE TO apply balance mutations and advance the checkpoint atomically within the same transaction, and SHALL CONTINUE TO reverse those mutations and rewind the checkpoint atomically during a reorg rollback

3.9 WHEN the `GET /health/indexer` endpoint is called THEN the system SHALL CONTINUE TO return a sanitized health snapshot containing `observedHeadBlock`, `finalizedBlock`, `projectionLag`, `rpcFailureCount`, `deadLetterCount`, and `status` without exposing credentials, RPC endpoints, or internal state beyond what the runbook defines

3.10 WHEN a backfill is in progress and the operator calls `POST /indexer/restart` THEN the system SHALL CONTINUE TO stop the running indexer, wait for in-flight operations to settle, and restart from the persisted `lastProcessedBlockNumber` checkpoint
