import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainEvent, TransferEventData } from './interfaces/blockchain-event.interface';

@Injectable()
export class BlockchainIndexerService {
  private readonly logger = new Logger(BlockchainIndexerService.name);

  constructor(
    @InjectRepository(ProcessedEvent)
    private processedEventRepo: Repository<ProcessedEvent>,
    @InjectRepository(TokenBalance)
    private tokenBalanceRepo: Repository<TokenBalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    private dataSource: DataSource,
  ) {}

  async processEvent(event: BlockchainEvent): Promise<void> {
    const { txHash, logIndex, blockNumber, eventType, data } = event;

    // Check if event already processed
    const existing = await this.processedEventRepo.findOne({
      where: { txHash, logIndex, blockNumber },
    });

    if (existing) {
      this.logger.log(`Event already processed: ${txHash}:${logIndex}:${blockNumber}`);
      return;
    }

    // Start transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Insert event record (will fail if unique constraint violated)
      const processedEvent = this.processedEventRepo.create({
        txHash,
        logIndex,
        blockNumber,
        eventType,
      });
      await queryRunner.manager.save(ProcessedEvent, processedEvent);

      // Process the event
      if (eventType === 'Transfer') {
        await this.updateBalances(queryRunner.manager, data as TransferEventData);
      }

      await queryRunner.commitTransaction();
      this.logger.log(`Processed event: ${eventType} at block ${blockNumber}`);

      // Save checkpoint after successful commit to avoid checkpoint desyncs
      // if the transaction is rolled back. Use repository (outside txn).
      await this.saveCheckpointAfterCommit(blockNumber);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to process event: ${error.message}`, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async updateBalances(manager: any, data: TransferEventData): Promise<void> {
    const { from, to, amount, token } = data;

    // Decrease sender balance
    await manager.decrement(TokenBalance, { address: from, tokenAddress: token }, 'balance', amount);

    // Increase receiver balance
    await manager.increment(TokenBalance, { address: to, tokenAddress: token }, 'balance', amount);
  }

  private async getLastBlock(manager: any): Promise<number | null> {
    const checkpoint = await manager.findOne(IndexerCheckpoint, { where: { id: 1 } });
    return checkpoint ? checkpoint.lastBlock : null;
  }

  private async saveCheckpoint(manager: any, blockNumber: number): Promise<void> {
    const currentLastBlock = (await this.getLastBlock(manager)) || 0;
    const nextLastBlock = Math.max(currentLastBlock, blockNumber);

    await manager.save(IndexerCheckpoint, {
      id: 1,
      lastBlock: nextLastBlock,
      updatedAt: new Date(),
    });
  }

  private async saveCheckpointAfterCommit(blockNumber: number): Promise<void> {
    const checkpoint = await this.checkpointRepo.findOne({ where: { id: 1 } });
    const currentLastBlock = checkpoint ? checkpoint.lastBlock : 0;
    const nextLastBlock = Math.max(currentLastBlock || 0, blockNumber);

    await this.checkpointRepo.save({
      id: 1,
      lastBlock: nextLastBlock,
      updatedAt: new Date(),
    });
  }

  async replayFromBlock(startBlock: number): Promise<void> {
    this.logger.log(`Starting replay from block ${startBlock}`);

    // Delete processed events from startBlock onwards (>= to prevent stale events)
    await this.processedEventRepo.createQueryBuilder()
      .delete()
      .where('blockNumber >= :startBlock', { startBlock })
      .execute();

    // Note: In a real implementation, you'd fetch events from blockchain
    // For now, assume events are provided externally or mocked
    // This is a placeholder for replay logic
    this.logger.log(`Replay completed from block ${startBlock}`);
  }

  async getLastProcessedBlock(): Promise<number | null> {
    const checkpoint = await this.checkpointRepo.findOne({ where: { id: 1 } });
    return checkpoint ? checkpoint.lastBlock : null;
  }
}