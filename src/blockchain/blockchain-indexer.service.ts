import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  MoreThanOrEqual,
  QueryFailedError,
} from 'typeorm';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenRalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainStateService } from './state.service';
import {
  BlockchainEvent,
  TransferEventData,
} from './interfaces/blockchain-event.interface';
import { ClaimsCache } from '../cache/claims.cache';
import { SequentialQueue } from './utils/sequential-queue';

/**
 * Canonical log identity for an indexed event.
 *
 * (chainId, releaseId, txHash, logIndex, decoderVersion) is the unique identity enforced by the
 * storage layer. Every processing path must resolve this identity from real chain/release/decoder
 * provenance and fail closed when any component is missing.
 */
export interface CanonicalLogIdentity {
  chainId: number;
  releaseId: string;
  txHash: string;
  logIndex: number;
  decoderVersion: string;
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
    private tokenBalanceRepo: Repository<TokenRalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    private dataSource: DataSource,
    private stateService: BlockchainStateService,
    private claimsCache: ClaimsCache,
  ) {}

  /**
   * Resolve the canonical log identity from an incoming event.
   *
   * Fails closed when chain, release, or decoder provenance is missing or
   * invalid. Without this, a duplicate from a different release or decoder could
   * slip past the idempotency check and double-apply state.
   */
  private resolveIdentity(event: BlockchainEvent): CanonicalLogIdentity {
    const { chainId, releaseId, txHash, logIndex, decoderVersion } = event;

    if (!Number.isInteger(chainId) || (chainId as number) <= 0) {
      throw new Error('Event is missing a valid chainId');
    }
    if (!releaseId || typeof releaseId !== 'string') {
      throw new Error('Event is missing releaseId provenance');
    }
    if (!decoderVersion || typeof decoderVersion !== 'string') {
      throw new Error('Event is missing decoderVersion provenance');
    }
    if (!txHash || typeof txHash !== 'string') {
      throw new Error('Event is missing txHash');
    }
    if (!Number.isInteger(logIndex) || logIndex < 0) {
      throw new Error('Event is missing a valid logIndex');
    }

    return {
      chainId: chainId as number,
      releaseId,
      txHash,
      logIndex,
      decoderVersion,
    };
  }

  /**
   * Process a single blockchain event. Enqueued so events are persisted one
   * at a time, in submission order.
   */
  async processEvent(event: BlockchainEvent): Promise<void> {
    return this.queue.enqueue(() => this.processEventInternal(event));
  }

  private async processEventInternal(event: BlockchainEvent): Promise<void> {
    const identity = this.resolveIdentity(event);
    const { blockNumber, eventType, data, removed } = event;

    // Removed logs must enter the rollback flow instead of being applied.
    if (removed) {
      await this.removeLog(identity, blockNumber, eventType);
      return;
    }

    // Idempotency: an event is uniquely identified by the canonical log
    // identity. Skipping here short-circuits duplicates before we open a transaction;
    // the unique index is the hard guarantee behind it.
    const existing = await this.processedEventRepo.findOne({
      where: {
        chainId: identity.chainId,
        releaseId: identity.releaseId,
        txHash: identity.txHash,
        logIndex: identity.logIndex,
        decoderVersion: identity.decoderVersion,
      },
    });

    if (existing) {
      this.logger.log(
        `Event already processed: chain=${identity.chainId} release=${identity.releaseId} ${identity.txHash}:${identity.logIndex} decoder=${identity.decoderVersion}`,
      );
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Persist the event record. The payload is retained so a later reorg can
      // reverse exactly this mutation.
      const processedEvent = this.processedEventRepo.create({
        chainId: identity.chainId,
        releaseId: identity.releaseId,
        decoderVersion: identity.decoderVersion,
        txHash: identity.txHash,
        logIndex: identity.logIndex,
        blockNumber,
        blockHash: event.blockHash ?? '',
        eventType,
        payload: data ?? null,
        removed: false,
      });
      await queryRunner.manager.save(ProcessedEvent, processedEvent);

      // Apply the state mutation for this event type, and track which
      // claims (if any) it actually affects so cache invalidation below
      // can be projection-aware instead of a blanket flush on every
      // event. `undefined` (the SequentialQueue's other event types, once
      // added, that haven't been taught to report their affected claims
      // yet) still falls back to the safe "invalidate everything" default
      // in ClaimsCache.invalidateForProjectionUpdate.
      let affectedClaimIds: string[] | undefined;
      if (eventType === 'Transfer') {
        await this.applyTransfer(
          queryRunner.manager,
          data as TransferEventData,
        );
        // A Transfer only mutates TokenBalance rows, which the claims
        // cache never reflects, so no claim is affected by this event.
        affectedClaimIds = [];
      }

      // Advance the checkpoint inside the S-ME transaction so the event, the
      // balance changes and the checkpoint all commit atomically. If anything
      // fails we roll back as a unit and the checkpoint never moves.
      await this.saveCheckpoint(queryRunner.manager, blockNumber);

      await queryRunner.commitTransaction();
      this.logger.log(`Processed event: ${eventType} at block ${blockNumber}`);

      // Invalidate cache after successfully committing a projection change.
      // Passing the actual affected claim IDs (an empty array included)
      // is what makes this projection-aware: a Transfer event no longer
      // pays for (and risks the thundering-herd effect of) flushing the
      // entire claims cache on every single indexed event.
      await this.claimsCache.invalidateForProjectionUpdate(affectedClaimIds);
    } catch (error) {
      await queryRunner.rollbackTransaction();

      // A concurrent ingestion of the same log can win the race between our
      // pre-check and the unique index. The database is the authority: treat
      // the conflict as an idempotent no-op rather than a failure.
      if (this.isUniqueViolation(error)) {
        this.logger.log(
          `Concurrent duplicate detected for chain=${identity.chainId} release=${identity.releaseId} ${identity.txHash}:${identity.logIndex} decoder=${identity.decoderVersion}; skipping`,
        );
        return;
      }

      this.logger.error(
        `Failed to process event: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Handle a removed log by routing it through the rollback flow.
   *
   * The log is marked as removed and its effects are reversed in the same
   * transaction. If the log was never applied (not found), the call is a
   * no-op. If it was already marked removed, the call is also a no-op.
   */
  private async removeLog(
    identity: CanonicalLogIdentity,
    blockNumber: number,
    eventType: string,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existing = await queryRunner.manager.findOne(ProcessedEvent, {
        where: {
          chainId: identity.chainId,
          releaseId: identity.releaseId,
          txHash: identity.txHash,
          logIndex: identity.logIndex,
          decoderVersion: identity.decoderVersion,
        },
      });

      if (!existing) {
        await queryRunner.commitTransaction();
        this.logger.warn(
          `Removed log not found in storage (chain=${identity.chainId} release=${identity.releaseId} ${identity.txHash}:${identity.logIndex} decoder=${identity.decoderVersion}); nothing to roll back`,
        );
        return;
      }

      if (existing.removed) {
        await queryRunner.commitTransaction();
        this.logger.log(
          `Removed log already rolled back (chain=${identity.chainId} release=${identity.releaseId} ${identity.txHash}:${identity.logIndex} decoder=${identity.decoderVersion})`,
        );
        return;
      }

      // Reverse the state mutation this log applied, reusing the same
      // reversal path as a reorg rollback.
      if (existing.eventType === 'Transfer' && existing.payload) {
        await this.reverseTransfer(
          queryRunner.manager,
          existing.payload as TransferEventData,
        );
      }

      // Mark the row removed so it is traceable and cannot be re-applied.
      await queryRunner.manager.update(ProcessedEvent, existing.id, {
        removed: true,
      });

      // Rewind the checkpoint if this log was the latest applied block.
      const checkpoint = await queryRunner.manager.findOne(IndexerCheckpoint, {
        where: { id: 1 },
      });
      if (checkpoint && checkpoint.lastBlock >= blockNumber) {
        const rewoundTo = Math.max(0, blockNumber - 1);
        await queryRunner.manager.save(IndexerCheckpoint, {
          id: 1,
          lastBlock: rewoundTo,
          updatedAt: new Date(),
        });
        await this.stateService.setProjectionHead(rewoundTo);
      }

      await queryRunner.commitTransaction();
      this.logger.log(
        `Rolled back removed log ${eventType} at block ${blockNumber} (chain=${identity.chainId} release=${identity.releaseId} decoder=${identity.decoderVersion})`,
      );
      await this.stateService.recordReplay(1);
      await this.claimsCache.invalidateAllForReorg();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to roll back removed log: ${error.message}`,
        error.stack,
      );
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
        if (event.removed) {
          continue;
        }
        if (event.eventType === 'Transfer' && event.payload) {
          await this.reverseTransfer(
            queryRunner.manager,
            event.payload as TransferEventData,
          );
        }
        await queryRunner.manager.update(ProcessedEvent, event.id, {
          removed: true,
        });
      }

      const rewoundTo = Math.max(0, startBlock - 1);
      await queryRunner.manager.save(IndexerCheckpoint, {
        id: 1,
        lastBlock: rewoundTo,
        updatedAt: new Date(),
      });

      await queryRunner.commitTransaction();
      await this.stateService.setProjectionHead(rewoundTo);
      await this.stateService.recordReplay(orphaned.length);
      await this.claimsCache.invalidateAllForReorg();
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

    if (from) {
      const sender = await manager.findOne(TokenBalance, {
        where: { address: from, token },
      });
      if (sender) {
        sender.balance = (BigInt(sender.balance) - BigInt(amount)).toString();
        await manager.save(TokenBalance, sender);
      }
    }

    if (to) {
      let receiver = await manager.findOne(TokenBalance, {
        where: { address: to, token },
      });
      if (!receiver) {
        receiver = manager.create(TokenBalance, {
          address: to,
          token,
          balance: '0',
        });
      }
      receiver.balance = (BigInt(receiver.balance) + BigInt(amount)).toString();
      await manager.save(TokenBalance, receiver);
    }
  }

  private async reverseTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    const { from, to, amount, token } = data;

    if (to) {
      const receiver = await manager.findOne(TokenBalance, {
        where: { address: to, token },
      });
      if (receiver) {
        receiver.balance = (BigInt(receiver.balance) - BigInt(amount)).toString();
        await manager.save(TokenBalance, receiver);
      }
    }

    if (from) {
      let sender = await manager.findOne(TokenBalance, {
        where: { address: from, token },
      });
      if (!sender) {
        sender = manager.create(TokenBalance, {
          address: from,
          token,
          balance: '0',
        });
      }
      sender.balance = (BigInt(sender.balance) + BigInt(amount)).toString();
      await manager.save(TokenBalance, sender);
    }
  }

  private async saveCheckpoint(
    manager: EntityManager,
    blockNumber: number,
  ): Promise<void> {
    const checkpoint = await manager.findOne(IndexerCheckpoint, {
      where: { id: 1 },
    });
    if (!checkpoint || checkpoint.lastBlock < blockNumber) {
      await manager.save(IndexerCheckpoint, {
        id: 1,
        lastBlock: blockNumber,
        updatedAt: new Date(),
      });
      await this.stateService.setProjectionHead(blockNumber);
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const code = (error as any).driverError?.code;
    return code === '23505' || code === '26000' || code === 'SQLITE_CONSTRAINT';
  }
}
