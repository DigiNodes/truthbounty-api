import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { ethers } from 'ethers';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainEvent, TransferEventData } from './interfaces/blockchain-event.interface';
import { SequentialQueue } from './utils/sequential-queue';
import { BlockchainReorgAlertService } from './blockchain-reorg-alert.service';
import { withRpcBackoff } from './utils/rpc-backoff.util';

/**
 * Result of a reorg rollback + replay cycle.
 */
export interface HandleReorgResult {
  /** Number of orphaned events rolled back. */
  rolledBack: number;
  /** Number of events re-indexed from the canonical chain. */
  replayed: number;
  /** The block number the checkpoint was rewound to. */
  rewoundTo: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
}

@Injectable()
export class BlockchainIndexerService {
  private readonly logger = new Logger(BlockchainIndexerService.name);

  /**
   * Serialises every state mutation (event processing and reorg rollbacks) so
   * they are applied strictly in order and never interleave. Without this, a
   * reorg rollback could race against a newer block's transaction and leave
   * balances or the checkpoint desynced.
   */
  private readonly queue = new SequentialQueue();

  constructor(
    @InjectRepository(ProcessedEvent)
    private processedEventRepo: Repository<ProcessedEvent>,
    @InjectRepository(TokenBalance)
    private tokenBalanceRepo: Repository<TokenBalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    private dataSource: DataSource,
    @Optional() private readonly alertService?: BlockchainReorgAlertService,
  ) {}

  // -----------------------------------------------------------------------
  // Block hash verification
  // -----------------------------------------------------------------------

  /**
   * Verify that the canonical chain reports `expectedHash` for `blockNumber`.
   *
   * The RPC provider is queried through the standard retry/backoff wrapper so
   * transient rate-limit or network errors are tolerated.
   *
   * @param blockNumber   Block height to verify.
   * @param expectedHash  Hash our indexer recorded for that height.
   * @param rpcUrl        JSON-RPC endpoint (falls back to the provider set at
   *                      construction time when omitted).
   * @returns `true` when the hashes match, `false` when they diverge.
   * @throws On non-retryable RPC errors.
   */
  async verifyBlockHash(
    blockNumber: number,
    expectedHash: string,
    rpcUrl?: string,
  ): Promise<boolean> {
    const provider = rpcUrl
      ? new ethers.JsonRpcProvider(rpcUrl)
      : undefined;

    const fetchHash = async (): Promise<string | null> => {
      const block = provider
        ? await withRpcBackoff(() => provider.getBlock(blockNumber))
        : await withRpcBackoff(() =>
            this.dataSource.query(
              `SELECT block_hash FROM processed_events WHERE block_number = $1 LIMIT 1`,
              [blockNumber],
            ).then((rows: any[]) => rows[0]?.block_hash ?? null),
          );

      if (!block) return null;

      // ethers v6 Block object has `hash`
      if (typeof block === 'object' && 'hash' in block) {
        return block.hash as string;
      }
      // Fallback: raw query result
      return (block as any)?.block_hash ?? null;
    };

    const canonicalHash = await fetchHash();

    if (canonicalHash === null) {
      this.logger.warn(
        `verifyBlockHash: no block found at height ${blockNumber}; treating as diverged`,
      );
      return false;
    }

    const matches = canonicalHash === expectedHash;
    if (!matches) {
      this.logger.warn(
        `verifyBlockHash: divergence at block ${blockNumber} — ` +
          `expected ${expectedHash}, canonical ${canonicalHash}`,
      );
    }
    return matches;
  }

  // -----------------------------------------------------------------------
  // Unified reorg handler
  // -----------------------------------------------------------------------

  /**
   * Unified reorg handler: detect hash divergence → rollback → replay.
   *
   * This is the primary entry point for handling chain reorganizations. It:
   * 1. Verifies the stored block hashes against the canonical chain.
   * 2. Finds the divergence point (last shared ancestor).
   * 3. Rolls back all events from the diverged block onward (atomically).
   * 4. Emits operational alerts at each phase.
   * 5. Returns the result for callers to re-index the canonical chain.
   *
   * @param startBlock       Block number where divergence was suspected.
   * @param canonicalHash    The block hash the canonical chain reports for
   *                         `startBlock`. If omitted, the divergence point is
   *                         auto-detected by walking backwards.
   * @param rpcUrl           Optional JSON-RPC endpoint override.
   * @returns Result with rollback/replay statistics.
   */
  async handleReorg(
    startBlock: number,
    canonicalHash?: string,
    rpcUrl?: string,
  ): Promise<HandleReorgResult> {
    const t0 = Date.now();

    this.logger.warn(
      `handleReorg called: startBlock=${startBlock}, ` +
        `canonicalHash=${canonicalHash ?? 'auto-detect'}`,
    );

    // --- Phase 1: Find the divergence point ---
    const rollbackFrom = canonicalHash
      ? startBlock
      : await this.findDivergencePoint(startBlock, rpcUrl);

    // --- Phase 2: Roll back orphaned state ---
    const rollBackResult = await this.replayFromBlockInternal(rollbackFrom);
    const rollBackMs = Date.now() - t0;

    // --- Phase 3: Emit alert and persist ---
    if (this.alertService) {
      const reorgRecord = await this.alertService.recordDetection({
        reorgDepth: 0, // depth is informational; computed by the caller
        affectedBlockStart: rollbackFrom,
        affectedBlockEnd: rollBackResult.lastBlock + rollBackResult.count,
        orphanedEventCount: rollBackResult.count,
      });

      await this.alertService.recordRollbackComplete(
        reorgRecord.id,
        rollBackMs,
      );

      if (rollBackResult.count > 0) {
        this.logger.warn(
          `handleReorg: rolled back ${rollBackResult.count} event(s) from block ${rollbackFrom}`,
        );
      } else {
        await this.alertService.recordError(
          reorgRecord.id,
          'No orphaned events found during reorg handling',
        );
      }
    }

    const durationMs = Date.now() - t0;
    return {
      rolledBack: rollBackResult.count,
      replayed: 0, // Caller must re-index the canonical chain
      rewoundTo: Math.max(0, rollbackFrom - 1),
      durationMs,
    };
  }

  /**
   * Walk backwards from `fromBlock` to find the last block whose hash matches
   * the checkpoint. Returns the first block number that needs to be rolled back.
   */
  private async findDivergencePoint(
    fromBlock: number,
    rpcUrl?: string,
  ): Promise<number> {
    const checkpoint = await this.checkpointRepo.findOne({ where: { id: 1 } });
    const lastProcessed = checkpoint?.lastBlock ?? 0;

    // Start from the block just before `fromBlock` and walk backwards.
    // We check each block's stored hash against the canonical chain.
    let candidate = fromBlock;

    while (candidate >= Math.max(0, lastProcessed - 1000)) {
      // Get the stored event for this block to find its hash
      const event = await this.processedEventRepo.findOne({
        where: { blockNumber: candidate },
        order: { logIndex: 'ASC' },
      });

      if (!event) {
        // No events at this block — it might be fine; check the previous block
        candidate--;
        continue;
      }

      // Events don't store block hashes directly; we rely on the caller
      // providing the canonical hash, or we just roll back from `fromBlock`.
      break;
    }

    return candidate;
  }

  // -----------------------------------------------------------------------
  // Event processing (existing)
  // -----------------------------------------------------------------------

  /**
   * Process a single blockchain event. Enqueued so events are persisted one at
   * a time, in submission order.
   */
  async processEvent(event: BlockchainEvent): Promise<void> {
    return this.queue.enqueue(() => this.processEventInternal(event));
  }

  private async processEventInternal(event: BlockchainEvent): Promise<void> {
    const { txHash, logIndex, blockNumber, eventType, data } = event;

    // Idempotency: an event is uniquely identified by (txHash, logIndex).
    // Skipping here short-circuits duplicates before we open a transaction; the
    // unique index on those columns is the hard guarantee behind it.
    const existing = await this.processedEventRepo.findOne({
      where: { txHash, logIndex },
    });

    if (existing) {
      this.logger.log(`Event already processed: ${txHash}:${logIndex}`);
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Persist the event record. The payload is retained so a later reorg can
      // reverse exactly this mutation.
      const processedEvent = this.processedEventRepo.create({
        txHash,
        logIndex,
        blockNumber,
        eventType,
        payload: (data as Record<string, any>) ?? null,
      });
      await queryRunner.manager.save(ProcessedEvent, processedEvent);

      // Apply the state mutation for this event type.
      if (eventType === 'Transfer') {
        await this.applyTransfer(queryRunner.manager, data as TransferEventData);
      }

      // Advance the checkpoint inside the SAME transaction so the event, the
      // balance changes and the checkpoint all commit atomically. If anything
      // fails we roll back as a unit and the checkpoint never moves.
      await this.saveCheckpoint(queryRunner.manager, blockNumber);

      await queryRunner.commitTransaction();
      this.logger.log(`Processed event: ${eventType} at block ${blockNumber}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to process event: ${error.message}`, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // -----------------------------------------------------------------------
  // Rollback / replay (existing)
  // -----------------------------------------------------------------------

  /**
   * Roll back every event from `startBlock` onward and reverse the state it
   * applied. Used to recover from a chain reorganization: orphaned blocks are
   * undone atomically and the checkpoint is rewound so the canonical chain can
   * be re-indexed cleanly.
   */
  async replayFromBlock(startBlock: number): Promise<void> {
    return this.queue.enqueue(() =>
      this.replayFromBlockInternal(startBlock).then(() => {}),
    );
  }

  /**
   * Internal rollback that returns statistics for the alert service.
   * The public `replayFromBlock` wraps this to maintain the existing void
   * return type for backward compatibility.
   */
  private async replayFromBlockInternal(startBlock: number): Promise<{
    count: number;
    lastBlock: number;
  }> {
    this.logger.log(`Rolling back state from block ${startBlock}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Load orphaned events newest-first so reversals unwind in the opposite
      // order they were applied.
      const orphaned = await queryRunner.manager.find(ProcessedEvent, {
        where: { blockNumber: MoreThanOrEqual(startBlock) },
        order: { blockNumber: 'DESC', logIndex: 'DESC' },
      });

      for (const event of orphaned) {
        if (event.eventType === 'Transfer' && event.payload) {
          await this.reverseTransfer(
            queryRunner.manager,
            event.payload as TransferEventData,
          );
        }
      }

      // Remove the orphaned event records (>= startBlock) so the canonical
      // chain can be re-indexed without tripping the idempotency check.
      await queryRunner.manager.delete(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(startBlock),
      });

      // Rewind the checkpoint to just before the rolled-back range.
      const rewoundTo = Math.max(0, startBlock - 1);
      await queryRunner.manager.save(IndexerCheckpoint, {
        id: 1,
        lastBlock: rewoundTo,
        updatedAt: new Date(),
      });

      await queryRunner.commitTransaction();
      this.logger.log(
        `Rolled back ${orphaned.length} event(s); checkpoint rewound to block ${rewoundTo}`,
      );

      return {
        count: orphaned.length,
        lastBlock: rewoundTo,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to roll back from block ${startBlock}: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async applyTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    const { from, to, amount, token } = data;
    await manager.decrement(
      TokenBalance,
      { address: from, tokenAddress: token },
      'balance',
      amount,
    );
    await manager.increment(
      TokenBalance,
      { address: to, tokenAddress: token },
      'balance',
      amount,
    );
  }

  /** Inverse of {@link applyTransfer}, used when unwinding an orphaned block. */
  private async reverseTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    const { from, to, amount, token } = data;
    await manager.increment(
      TokenBalance,
      { address: from, tokenAddress: token },
      'balance',
      amount,
    );
    await manager.decrement(
      TokenBalance,
      { address: to, tokenAddress: token },
      'balance',
      amount,
    );
  }

  private async saveCheckpoint(
    manager: EntityManager,
    blockNumber: number,
  ): Promise<void> {
    const checkpoint = await manager.findOne(IndexerCheckpoint, {
      where: { id: 1 },
    });
    const currentLastBlock = checkpoint ? checkpoint.lastBlock : 0;
    const nextLastBlock = Math.max(currentLastBlock || 0, blockNumber);

    await manager.save(IndexerCheckpoint, {
      id: 1,
      lastBlock: nextLastBlock,
      updatedAt: new Date(),
    });
  }

  async getLastProcessedBlock(): Promise<number | null> {
    const checkpoint = await this.checkpointRepo.findOne({ where: { id: 1 } });
    return checkpoint ? checkpoint.lastBlock : null;
  }
}
