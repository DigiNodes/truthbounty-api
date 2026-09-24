import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { ethers, EventLog } from 'ethers';
import { IndexedEvent, IndexingState } from '../entities';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventIndexerConfig } from '../config';
import { serializeBigInts } from '../common/utils/bigint-serialization.util';
import { withRpcBackoff, isRetryableRpcError } from '../blockchain/utils/rpc-backoff.util';
import { BlockchainStateService } from '../blockchain/state.service';

/**
 * Detects provider range-too-large errors across the shapes different JSON-RPC
 * clients and providers surface them.
 */
function isRangeTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, any>;
  const msg = String(err.message ?? err.shortMessage ?? '').toLowerCase();
  // Alchemy: "Log response size exceeded", Infura: "query returned more than X results"
  // Generic JSON-RPC: -32005 code "limit exceeded"
  return (
    msg.includes('query returned more than') ||
    msg.includes('log response size exceeded') ||
    msg.includes('block range is too large') ||
    msg.includes('range too large') ||
    msg.includes('exceed maximum block range') ||
    err.code === -32005
  );
}

/**
 * Core event indexing service.
 *
 * V2-BE-125 fixes applied:
 *  1.1 — Adaptive range halving when provider rejects getLogs as too large.
 *  1.2 — High-throughput adaptive backfill mode for large gaps.
 *  1.3 — endBlock capped at provider-reported finalized block.
 *  1.4 — Dead-letter state + stateService.recordDeadLetter() on exhausted retries.
 *  1.5 — Event rows + checkpoint written in a single DB transaction.
 *  1.6 — Backfill blockNumber validated against v2_contract_artifacts deploymentBlock (controller).
 *  1.7 — Historical blocks <= finalizedBlock are immediately isFinalized = true.
 *  1.8 — reconcileReorgs paginated (default 1000 rows/page).
 */
@Injectable()
export class EventIndexerService {
  private readonly logger = new Logger(EventIndexerService.name);
  private provider: ethers.JsonRpcProvider;
  private currentBlockNumber: number = 0;
  private isIndexing: boolean = false;

  /** Effective batch size for the current backfill pass; reduced when the
   *  provider rejects a range as too large (fix 1.1). */
  private effectiveBatchSize: number;

  private readonly minBatchSizeFloor: number;
  private readonly adaptiveFillThresholdBlocks: number;
  private readonly reorgPageSize: number = 1000;

  constructor(
    config: EventIndexerConfig,
    eventRepository: Repository<IndexedEvent>,
    stateRepository: Repository<IndexingState>,
    dataSource?: DataSource,
    stateService?: BlockchainStateService,
    artifactRepository?: Repository<ContractArtifact>,
  );
  constructor(
    private config: EventIndexerConfig,
    private eventRepository: Repository<IndexedEvent>,
    private stateRepository: Repository<IndexingState>,
    private readonly dataSource?: DataSource,
    private readonly stateService?: BlockchainStateService,
    private readonly artifactRepository?: Repository<ContractArtifact>,
  ) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.effectiveBatchSize = config.blockRangePerBatch;
    this.minBatchSizeFloor = config.minBatchSizeFloor ?? 1;
    this.adaptiveFillThresholdBlocks = config.adaptiveFillThresholdBlocks ?? 10_000;
  }

  // ─── Public lifecycle ────────────────────────────────────────────────────────

  /** Start the indexing service. */
  async start(): Promise<void> {
    if (this.isIndexing) {
      this.logger.warn('Indexer is already running');
      return;
    }

    this.logger.log('Starting event indexer...');
    this.isIndexing = true;

    try {
      for (const contract of this.config.contracts) {
        for (const event of contract.events) {
          await this.initializeIndexingState(contract.address, event.name);
        }
      }
      this.startIndexingLoop();
    } catch (error) {
      this.logger.error('Failed to start indexer:', error);
      this.isIndexing = false;
      throw error;
    }
  }

  /** Stop the indexing service. */
  stop(): void {
    this.logger.log('Stopping event indexer...');
    this.isIndexing = false;
  }

  /** Get current indexing status. */
  async getStatus(): Promise<Record<string, any>> {
    const states = await this.stateRepository.find();
    return {
      isRunning: this.isIndexing,
      currentBlockNumber: this.currentBlockNumber,
      indexingStates: states.map((s) => ({
        contractAddress: s.contractAddress,
        eventType: s.eventType,
        lastProcessedBlock: s.lastProcessedBlockNumber,
        status: s.status,
        totalEvents: s.totalEventCount,
        processedEvents: s.processedEventCount,
        failedEvents: s.failedEventCount,
      })),
    };
  }

  /**
   * Reset the cursor to `blockNumber - 1` and enter backfill status.
   *
   * Fix 1.2: when the gap between `blockNumber` and the provider's current
   * finalized block exceeds `adaptiveFillThresholdBlocks`, the service enters
   * high-throughput mode (no polling-interval wait between batches) until the
   * gap is closed.
   *
   * Fix 1.6: deployment-block validation is enforced in the controller layer
   * (`IndexerController.backfill`) before this method is called, so here we
   * only perform the cursor reset and emit the structured log.
   */
  async backfillFromBlock(contractAddress: string, blockNumber: number): Promise<void> {
    const state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
      },
    });

    if (!state) {
      throw new Error(`No indexing state found for contract ${contractAddress}`);
    }

    // Reset effective batch size so each new backfill pass starts fresh.
    this.effectiveBatchSize = this.config.blockRangePerBatch;

    state.lastProcessedBlockNumber = blockNumber - 1;
    state.status = 'backfilling';
    await this.stateRepository.save(state);

    // Fix 1.2: detect large-gap and enter adaptive high-throughput mode.
    let finalizedBlock: number;
    try {
      finalizedBlock = await this.fetchFinalizedBlockNumber();
    } catch {
      finalizedBlock = this.currentBlockNumber;
    }

    const gap = finalizedBlock - blockNumber;
    if (gap > this.adaptiveFillThresholdBlocks) {
      this.logger.log(
        JSON.stringify({
          event: 'adaptive_backfill_mode_entered',
          contractAddress,
          startBlock: blockNumber,
          finalizedBlock,
          gapBlocks: gap,
          thresholdBlocks: this.adaptiveFillThresholdBlocks,
        }),
      );
      // Run high-throughput backfill immediately, without waiting for the
      // normal poll interval. The loop re-enters standard polling once the gap
      // is below the threshold.
      await this.runAdaptiveBackfill(contractAddress, blockNumber, finalizedBlock);
    } else {
      this.logger.log(`Backfilling from block ${blockNumber} for ${contractAddress}`);
    }
  }

  // ─── Artifact lookup (used by controller for fix 1.6) ───────────────────────

  /**
   * Return the deployment block recorded in `v2_contract_artifacts` for a
   * given chain + address, or `null` if no approved artifact exists.
   */
  async getDeploymentBlock(
    chainId: number,
    contractAddress: string,
  ): Promise<bigint | null> {
    if (!this.artifactRepository) return null;
    const artifact = await this.artifactRepository.findOne({
      where: { chainId, contractAddress: contractAddress.toLowerCase() },
    });
    if (!artifact || !artifact.isApproved) return null;
    if (artifact.deploymentBlock == null) return null;
    return BigInt(artifact.deploymentBlock);
  }

  // ─── Main polling loop ───────────────────────────────────────────────────────

  private startIndexingLoop(): void {
    const poll = async () => {
      try {
        if (!this.isIndexing) return;

        const blockNumber = await this.provider.getBlockNumber();
        this.currentBlockNumber = blockNumber;

        for (const contract of this.config.contracts) {
          await this.indexContract(contract.address, blockNumber);
        }

        await this.reconcileReorgs(blockNumber);
        await this.retryFailedEvents();
      } catch (error) {
        this.logger.error('Error in indexing loop:', error);
      } finally {
        if (this.isIndexing) {
          setTimeout(poll, this.config.pollingIntervalMs);
        }
      }
    };

    poll();
  }

  // ─── High-throughput adaptive backfill (fix 1.2) ────────────────────────────

  /**
   * Drain all historical blocks between `startBlock` and `finalizedBlock` as
   * fast as the provider allows, without inserting a poll-interval delay
   * between batches.
   */
  private async runAdaptiveBackfill(
    contractAddress: string,
    startBlock: number,
    finalizedBlock: number,
  ): Promise<void> {
    let cursor = startBlock;

    while (cursor <= finalizedBlock && this.isIndexing) {
      for (const contract of this.config.contracts) {
        if (contract.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
        for (const eventConfig of contract.events) {
          await this.indexEventType(contractAddress, eventConfig, finalizedBlock);
        }
      }

      // Advance cursor by effectiveBatchSize after each pass.
      cursor += this.effectiveBatchSize;

      // Re-check finalized block so we don't overshoot.
      try {
        finalizedBlock = await this.fetchFinalizedBlockNumber();
      } catch {
        // Keep using the last known finalized block on transient failure.
      }
    }

    this.logger.log(
      JSON.stringify({
        event: 'adaptive_backfill_mode_exited',
        contractAddress,
        finalCursor: cursor,
        finalizedBlock,
      }),
    );
  }

  // ─── Contract / event indexing ───────────────────────────────────────────────

  private async indexContract(
    contractAddress: string,
    currentBlockNumber: number,
  ): Promise<void> {
    try {
      const contract = this.config.contracts.find(
        (c) => c.address.toLowerCase() === contractAddress.toLowerCase(),
      );
      for (const eventConfig of contract?.events ?? []) {
        await this.indexEventType(contractAddress, eventConfig, currentBlockNumber);
      }
    } catch (error) {
      this.logger.error(`Failed to index contract ${contractAddress}:`, error);
    }
  }

  /**
   * Index one event type for one contract up to the provider-reported finalized
   * block (fix 1.3) within a single atomic DB transaction (fix 1.5).
   */
  private async indexEventType(
    contractAddress: string,
    eventConfig: any,
    currentBlockNumber: number,
  ): Promise<void> {
    const state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
        eventType: eventConfig.name,
      },
    });

    if (!state) {
      this.logger.debug(`No state found for ${contractAddress}:${eventConfig.name}`);
      return;
    }

    // Fix 1.3: cap endBlock at the provider-reported finalized block, not at
    // currentBlockNumber - confirmationsRequired, so the cursor never advances
    // past canonical finality.
    let providerFinalizedBlock: number;
    try {
      providerFinalizedBlock = await this.fetchFinalizedBlockNumber();
      await this.stateService?.setFinalizedBlock(providerFinalizedBlock);
      await this.stateService?.setObservedHead(currentBlockNumber);
    } catch {
      // Fail closed: if we cannot determine the finalized block we conservatively
      // use currentBlockNumber - confirmationsRequired.
      providerFinalizedBlock = currentBlockNumber - this.config.confirmationsRequired;
    }

    const startBlock = state.lastProcessedBlockNumber + 1;
    const endBlock = Math.min(
      startBlock + this.effectiveBatchSize - 1,
      providerFinalizedBlock,
    );

    if (startBlock > endBlock) {
      return;
    }

    try {
      // Fix 1.1: adaptive range halving — fetch with automatic halving on
      // range-too-large errors, permanently shrinking effectiveBatchSize.
      const events = await this.fetchEventsAdaptive(
        contractAddress,
        eventConfig.signature,
        startBlock,
        endBlock,
      );

      // Fix 1.5: write all event rows + checkpoint in one transaction.
      await this.persistBatch(
        contractAddress,
        eventConfig,
        events,
        endBlock,
        providerFinalizedBlock,
        state,
      );

      this.logger.log(
        `Indexed ${events.length} ${eventConfig.name} events from blocks ${startBlock}-${endBlock}`,
      );
    } catch (error) {
      state.status = 'error';
      state.errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      await this.stateRepository.save(state);
      this.logger.error(
        `Error indexing ${eventConfig.name} from ${contractAddress}:`,
        error,
      );
    }
  }

  // ─── Fix 1.3: finalized block from provider ──────────────────────────────────

  /**
   * Fetch the provider-reported finalized block number via
   * `eth_getBlockByNumber("finalized", false)`.
   */
  private async fetchFinalizedBlockNumber(): Promise<number> {
    const block = await withRpcBackoff(
      () =>
        this.provider.send('eth_getBlockByNumber', ['finalized', false]) as Promise<{
          number: string;
        }>,
    );
    return parseInt(block.number, 16);
  }

  // ─── Fix 1.1: adaptive range halving ────────────────────────────────────────

  /**
   * Fetch events with automatic block-range halving when the provider rejects
   * the range as too large.  Permanently reduces `effectiveBatchSize` for
   * subsequent batches in the same pass (fix 1.1).
   */
  private async fetchEventsAdaptive(
    contractAddress: string,
    eventSignature: string,
    fromBlock: number,
    toBlock: number,
  ): Promise<EventLog[]> {
    let currentFrom = fromBlock;
    let currentTo = toBlock;
    const allLogs: EventLog[] = [];

    while (currentFrom <= toBlock) {
      try {
        const logs = await withRpcBackoff(
          () =>
            this.provider.getLogs({
              address: contractAddress,
              topics: [eventSignature],
              fromBlock: currentFrom,
              toBlock: currentTo,
            }),
          {
            // Only retry transient errors here; range errors are handled below.
            isRetryable: (err) =>
              isRetryableRpcError(err) && !isRangeTooLargeError(err),
            onRetry: (error, attempt, delayMs) =>
              this.logger.warn(
                `RPC getLogs throttled (blocks ${currentFrom}-${currentTo}), ` +
                  `retry ${attempt} in ${delayMs}ms: ${(error as Error)?.message ?? error}`,
              ),
          },
        );
        allLogs.push(...(logs as EventLog[]));

        // Advance window.
        currentFrom = currentTo + 1;
        currentTo = Math.min(currentFrom + this.effectiveBatchSize - 1, toBlock);
      } catch (err) {
        if (isRangeTooLargeError(err)) {
          const rangeSize = currentTo - currentFrom + 1;
          const halved = Math.max(
            this.minBatchSizeFloor,
            Math.floor(rangeSize / 2),
          );
          this.logger.warn(
            `Provider rejected range ${currentFrom}-${currentTo} (size ${rangeSize}); ` +
              `halving to ${halved} blocks`,
          );

          // Permanently reduce effective batch size for this pass (fix 1.1).
          if (halved < this.effectiveBatchSize) {
            this.effectiveBatchSize = halved;
            this.logger.warn(
              `effectiveBatchSize permanently reduced to ${this.effectiveBatchSize} for this pass`,
            );
          }

          if (halved <= 0 || currentFrom === currentTo) {
            // Cannot halve further; propagate to the caller so the state is set
            // to error rather than silently skipping blocks.
            throw err;
          }

          currentTo = currentFrom + halved - 1;
          // Loop will retry with the smaller range.
        } else {
          throw err;
        }
      }
    }

    return allLogs;
  }

  // ─── Fix 1.5: atomic batch persistence ──────────────────────────────────────

  /**
   * Write all event rows and the updated checkpoint in a single DB transaction
   * so a mid-batch restart cannot leave events persisted without the checkpoint
   * advancing (or vice-versa).
   */
  private async persistBatch(
    contractAddress: string,
    eventConfig: any,
    logs: EventLog[],
    endBlock: number,
    finalizedBlock: number,
    state: IndexingState,
  ): Promise<void> {
    if (!this.dataSource) {
      // Fallback for unit-test contexts where DataSource is not injected.
      for (const log of logs) {
        await this.processEvent(
          contractAddress,
          eventConfig,
          log,
          endBlock,
          finalizedBlock,
        );
      }
      state.lastProcessedBlockNumber = endBlock;
      state.lastIndexedAt = new Date();
      state.status = 'idle';
      await this.stateRepository.save(state);
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const log of logs) {
        await this.persistEventInTx(
          queryRunner.manager,
          contractAddress,
          eventConfig,
          log,
          endBlock,
          finalizedBlock,
        );
      }

      // Advance checkpoint inside the same transaction (fix 1.5).
      await queryRunner.manager.save(IndexingState, {
        ...state,
        lastProcessedBlockNumber: endBlock,
        lastIndexedAt: new Date(),
        status: 'idle',
        errorMessage: null,
      });

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Fix 1.7: finality-aware event persistence ──────────────────────────────

  /**
   * Persist a single event row inside an existing transaction manager.
   * Fix 1.7: events whose blockNumber <= finalizedBlock are immediately marked
   * isFinalized = true, bypassing the live-tip confirmation count because
   * finalized historical blocks are canonical by protocol definition.
   */
  private async persistEventInTx(
    manager: any,
    contractAddress: string,
    eventConfig: any,
    log: EventLog,
    batchEndBlock: number,
    finalizedBlock: number,
  ): Promise<void> {
    // Idempotency check.
    const existing = await manager.findOne(IndexedEvent, {
      where: {
        transactionHash: log.transactionHash,
        logIndex: log.index,
        eventType: eventConfig.name,
      },
    });
    if (existing) return;

    const iface = new ethers.Interface([eventConfig.abi]);
    const parsed = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    // Fix 1.7: historical finalized blocks skip the confirmation count check.
    const isHistoricallyFinalized = log.blockNumber <= finalizedBlock;
    const confirmations = isHistoricallyFinalized
      ? this.config.confirmationsRequired
      : Math.max(0, batchEndBlock - log.blockNumber);
    const isFinalized =
      isHistoricallyFinalized || confirmations >= this.config.confirmationsRequired;

    const event = manager.create(IndexedEvent, {
      eventType: eventConfig.name,
      contractAddress,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      chainId: this.config.chainId,
      eventData: serializeBigInts(log) as Record<string, any>,
      parsedData: serializeBigInts(parsed?.args || {}) as Record<string, any>,
      confirmations,
      isFinalized,
      isProcessed: false,
      processingError: null,
      retryAttempts: 0,
    });

    await manager.save(IndexedEvent, event);
  }

  /**
   * Non-transactional single-event path (kept for contexts without DataSource).
   */
  private async processEvent(
    contractAddress: string,
    eventConfig: any,
    log: EventLog,
    batchEndBlock: number,
    finalizedBlock: number,
  ): Promise<void> {
    try {
      const existing = await this.eventRepository.findOne({
        where: {
          transactionHash: log.transactionHash,
          logIndex: log.index,
          eventType: eventConfig.name,
        },
      });
      if (existing) return;

      const iface = new ethers.Interface([eventConfig.abi]);
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      // Fix 1.7: historical finalized blocks are immediately finalized.
      const isHistoricallyFinalized = log.blockNumber <= finalizedBlock;
      const confirmations = isHistoricallyFinalized
        ? this.config.confirmationsRequired
        : Math.max(0, batchEndBlock - log.blockNumber);
      const isFinalized =
        isHistoricallyFinalized || confirmations >= this.config.confirmationsRequired;

      const event = this.eventRepository.create({
        eventType: eventConfig.name,
        contractAddress,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        chainId: this.config.chainId,
        eventData: serializeBigInts(log) as Record<string, any>,
        parsedData: serializeBigInts(parsed?.args || {}) as Record<string, any>,
        confirmations,
        isFinalized,
        isProcessed: false,
        processingError: null,
        retryAttempts: 0,
      });

      await this.eventRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to process event ${log.transactionHash}:${log.index}:`,
        error,
      );
    }
  }

  // ─── Fix 1.8: paginated reorg reconciliation ─────────────────────────────────

  /**
   * Detect and handle chain reorgs.
   *
   * Fix 1.8: loads finalized events in pages (default 1000/page) so the
   * entire event history is never held in memory simultaneously.
   */
  private async reconcileReorgs(currentBlockNumber: number): Promise<void> {
    try {
      let offset = 0;

      while (true) {
        const page = await this.eventRepository.find({
          where: { isFinalized: true },
          take: this.reorgPageSize,
          skip: offset,
          order: { blockNumber: 'ASC' },
        });

        if (page.length === 0) break;

        for (const event of page) {
          const confirmations = currentBlockNumber - event.blockNumber;
          if (confirmations < this.config.confirmationsRequired) {
            this.logger.warn(
              `Potential reorg detected for event ${event.transactionHash}:${event.logIndex}`,
            );
            event.isFinalized = false;
            event.isProcessed = false;
            event.processingError = null;
            event.retryAttempts = 0;
            await this.eventRepository.save(event);
          }
        }

        offset += this.reorgPageSize;
        if (page.length < this.reorgPageSize) break;
      }
    } catch (error) {
      this.logger.error('Error reconciling reorgs:', error);
    }
  }

  // ─── Fix 1.4: dead-letter handling ───────────────────────────────────────────

  /**
   * Retry failed events.
   *
   * Fix 1.4: events that have reached maxRetryAttempts are permanently
   * transitioned to `dead_letter` status and `stateService.recordDeadLetter()`
   * is called so the `IndexerHealthSnapshot` dead-letter counter reflects
   * reality and the `degraded` health threshold can be triggered.
   */
  private async retryFailedEvents(): Promise<void> {
    try {
      const failedEvents = await this.eventRepository.find({
        where: {
          isProcessed: false,
          retryAttempts: this.config.maxRetryAttempts,
        },
      });

      if (failedEvents.length === 0) return;

      this.logger.warn(
        `${failedEvents.length} event(s) failed after max retries — dead-lettering`,
      );

      for (const event of failedEvents) {
        // Look up (or create) the per-contract IndexingState to carry the
        // permanent dead_letter status and prevent re-retry.
        const state = await this.stateRepository.findOne({
          where: {
            chainId: this.config.chainId,
            contractAddress: event.contractAddress,
            eventType: event.eventType,
          },
        });

        if (state && state.status !== 'dead_letter') {
          state.status = 'dead_letter';
          state.errorMessage = `Event ${event.transactionHash}:${event.logIndex} dead-lettered after ${this.config.maxRetryAttempts} attempts`;
          await this.stateRepository.save(state);
        }

        // Fix 1.4: increment the dead-letter counter so health reflects reality.
        await this.stateService?.recordDeadLetter(1);
      }
    } catch (error) {
      this.logger.error('Error in dead-letter handling:', error);
    }
  }

  // ─── Initialization ───────────────────────────────────────────────────────────

  private async initializeIndexingState(
    contractAddress: string,
    eventType: string,
  ): Promise<void> {
    const contract = this.config.contracts.find(
      (c) => c.address.toLowerCase() === contractAddress.toLowerCase(),
    );
    if (!contract) return;

    let state = await this.stateRepository.findOne({
      where: {
        chainId: this.config.chainId,
        contractAddress,
        eventType,
      },
    });

    if (!state) {
      state = this.stateRepository.create({
        chainId: this.config.chainId,
        contractAddress,
        eventType,
        lastProcessedBlockNumber: contract.startBlock - 1,
        lastScannedBlockNumber: contract.startBlock - 1,
        status: 'idle',
        blockRangePerBatch: this.config.blockRangePerBatch,
        confirmationsRequired: this.config.confirmationsRequired,
        maxRetryAttempts: this.config.maxRetryAttempts,
      });
      await this.stateRepository.save(state);
      this.logger.log(
        `Initialized state for ${contractAddress}:${eventType} from block ${contract.startBlock}`,
      );
    }
  }
}
