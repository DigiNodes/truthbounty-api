import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainEvent, TransferEventData } from './interfaces/blockchain-event.interface';
import { SequentialQueue } from './utils/sequential-queue';

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
  ) {}

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

  /**
   * Roll back every event from `startBlock` onward and reverse the state it
   * applied. Used to recover from a chain reorganization: orphaned blocks are
   * undone atomically and the checkpoint is rewound so the canonical chain can
   * be re-indexed cleanly.
   */
  async replayFromBlock(startBlock: number): Promise<void> {
    return this.queue.enqueue(() => this.replayFromBlockInternal(startBlock));
  }

  private async replayFromBlockInternal(startBlock: number): Promise<void> {
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
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to roll back from block ${startBlock}: ${error.message}`, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async applyTransfer(manager: EntityManager, data: TransferEventData): Promise<void> {
    const { from, to, amount, token } = data;
    await manager.decrement(TokenBalance, { address: from, tokenAddress: token }, 'balance', amount);
    await manager.increment(TokenBalance, { address: to, tokenAddress: token }, 'balance', amount);
  }

  /** Inverse of {@link applyTransfer}, used when unwinding an orphaned block. */
  private async reverseTransfer(manager: EntityManager, data: TransferEventData): Promise<void> {
    const { from, to, amount, token } = data;
    await manager.increment(TokenBalance, { address: from, tokenAddress: token }, 'balance', amount);
    await manager.decrement(TokenBalance, { address: to, tokenAddress: token }, 'balance', amount);
  }

  private async saveCheckpoint(manager: EntityManager, blockNumber: number): Promise<void> {
    const checkpoint = await manager.findOne(IndexerCheckpoint, { where: { id: 1 } });
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
