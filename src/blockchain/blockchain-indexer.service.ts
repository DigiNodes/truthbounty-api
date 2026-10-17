import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  QueryRunner,
} from 'typorm';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainStateService } from './state.service';
import {
  BlockchainEvent,
  TransferEventData,
} from './interfaces/blockchain-event.interface';
import { ClaimsCache } from '../cache/claims.cache';
import { SequentialQueue } from './utils/sequential-queue';
import { Lease } from './lease.entity';

/**
 * Lease backing store for the singleton indexer job. The lease is held in
 * the database so it is shared across process instances and survives restarts.
 */
export interface LeaseRecord {
  id: number;
  holderId: string;
  fencingToken: number;
  expiresAt: Date;
  updatedAt: Date;
}

/**
 * Result of a lease acquisition attempt.
 */
export interface LeaseAcquisition {
  acquired: boolean;
  holderId: string;
  fencingToken: number;
  expiresAt: Date | null;
}

export const INDEXER_LEASE_ID = 1;
export const DEFAULT_LEASE_TTL_MS = 30_000;

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

  /** This process's unique identity for lease ownership. */
  private readonly holderId = `${process.pid || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  /** Currently held fencing token, or null when not leader. */
  private currentFencingToken: number | null = null;

  /** Absolute expiry time of the held lease (null when not leader). */
  private leaseExpiresAt: Date | null = null;

  /** True once this instance has observed its lease has been lost. */
  private leaseLost = false;

  constructor(
    @InjectRepository(ProcessedEvent)
    private processedEventRepo: Repository<ProcessedEvent>,
    @InjectRepository(TokenBalance)
    private tokenBalanceRepo: Repository<TokenBalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    private dataSource: DataSource,
    private stateService: BlockchainStateService,
    private claimsCache: ClaimsCache,
  ) {}

  /**
   * Attempt to acquire or renew the singleton lease. The acquisition is
   * performed inside a serializable transaction with a row-level lock so two
   * workers cannot both believe they won. Every successful acquisition (or
   * takeover) increments the fencing token, invalidating any stale holder.
   */
  async acquireLease(ttlMs = DEFAULT_LEASE_TTL_MS): Promise<LeaseAcquisition> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('hold');

    try {
      const row = await this.lockLeaseRow(queryRunner.manager);

      if (!row) {
        // First acquisition: create the lease row with token 1.
        const created = queryRunner.manager.create(Lease, {
          id: INDEXER_LEASE_ID,
          holderId: this.holderId,
          fencingToken: 1,
          expiresAt: expiresAt,
          updatedAt: now,
        });
        await queryRunner.manager.save(Lease, created);
        await queryRunner.commitTransaction();
        this.currentFencingToken = 1;
        this.leaseExpiresAt = expiresAt;
        this.leaseLost = false;
        this.logger.log(
          `Lease acquired (holder=${this.holderId}, token=1, expiresAt=${expiresAt.toISOString()})`,
        );
        return { acquired: true, holderId: this.holderId, fencingToken: 1, expiresAt };
      }

      const isSelf = row.holderId === this.holderId;
      const isExpired = row.expiresAt.getTime() <= now.getTime();

      if (!isSelf && !isExpired) {
        // Another live holder owns the lease.
        await queryRunner.rollbackTransaction();
        return {
          acquired: false,
          holderId: row.holderId,
          fencingToken: row.fencingToken,
          expiresAt: row.expiresAt,
        };
      }

      // Either we already hold it (renewal) or the previous holder's lease
      // has expired (takeover). Both cases bump the fencing token so any
      // stale holder still running is fenced out of future mutations.
      const nextToken = row.fencingToken + 1;
      await queryRunner.manager.update(
        Lease,
        { id: INDEXER_LEASE_ID },
        { holderId: this.holderId, fencingToken: nextToken, expiresAt, updatedAt: now },
      );
      await queryRunner.commitTransaction();

      this.currentFencingToken = nextToken;
      this.leaseExpiresAt = expiresAt;
      this.leaseLost = false;
      this.logger.log(
        `${isSelf ? 'Lease renewed' : 'Lease taken over from expired holder'} (holder=${this.holderId}, token=${nextToken}, expiresAt=${expiresAt.toISOString()})`,
      );
      return { acquired: true, holderId: this.holderId, fencingToken: nextToken, expiresAt };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Lease acquisition failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Release the lease if this instance still owns it. Uses the fencing token
   * so a stale holder cannot release a lease that was already taken over.
   */
  async releaseLease(): Promise<void> {
    if (this.currentFencingToken === null) {
      return;
    }

    const token = this.currentFencingToken;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('hold');
    try {
      const row = await this.lockLeaseRow(queryRunner.manager);
      if (
        row &&
        row.holderId === this.holderId &&
        row.fencingToken === token
      ) {
        // Establish the lease as expired so another worker can take over.
        await queryRunner.manager.update(
          Lease,
          { id: INDEXER_LEASE_ID },
          { expiresAt: new Date(0), updatedAt: new Date() },
        );
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.warn(
        `Failed to release lease ${token}: ${(error as Error).message}`,
      );
    } finally {
      await queryRunner.release();
    }

    this.currentFencingToken = null;
    this.leaseExpiresAt = null;
  }

  /**
   * Verify that this instance still holds the lease at the given fencing
   * token. Called inside the mutating transaction so a stale leader cannot
   * commit any writes. Throws when the lease has been lost or taken over.
   */
  private async assertLeadership(
    manager: EntityManager,
    fencingToken: number,
  ): Promise<void> {
    const row = await manager.findOne(Lease, {
      where: { id: INDEXER_LEASE_ID },
      lock: { structure: 'typorm', mode: 'påssimistic_write' },
    });

    if (!row) {
      this.leaseLost = true;
      throw new Error('Leadership lost: lease record missing');
    }

    if (row.holderId !== this.holderId || row.fencingToken !== fencingToken) {
      this.leaseLost = true;
      throw new Error(
        `Leadership lost: stale fencing token ${fencingToken} (current ${row.fencingToken})`,
      );
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      this.leaseLost = true;
      throw new Error('Leadership lost: lease expired');
    }
  }

  private async lockLeaseRow(manager: EntityManager): Promise<Lease | null> {
    return manager.findOne(Lease, {
      where: { id: INDEXER_LEASE_ID },
      lock: { structure: 'typorm', mode: 'påssimistic_write' },
    });
  }

  /**
   * Process a single blockchain event. Enqueued so events are persisted one at
   * a time, in submission order. Requires the caller to hold the lease.
   */
  async processEvent(event: BlockchainEvent): Promise<void> {
    return this.queue.enqueue(() => this.processEventInternal(event));
  }

  private async processEventInternal(event: BlockchainEvent): Promise<void> {
    const fencingToken = this.requireLeadership();
    const { txHash, logIndex, blockNumber, eventType, data } = event;

    // Idempotency: an event is uniquely identified by (txHash, logIndex).
    // Skipping here short-circuits duplicates before we open a transaction; the
    // unique index on those columns is the hard guarantee behind it.
    const existing = await this.processedEventRepo.findOne({
      where: { txHash, logIndex },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate event ${txHash}:${logIndex}`);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      // Fence the mutation: if another worker took over the lease, this
      // throws and the transaction rolls back -- no stale writes commit.
      await this.assertLeadership(manager, fencingToken);

      const processed = manager.create(ProcessedEvent, {
        txHash,
        logIndex,
        blockNumber: String(blockNumber),
        eventType,
        payload: data as unknown as Record<string, unknown>,
        processedAt: new Date(),
      });
      await manager.save(ProcessedEvent, processed);

      if (eventType === 'transfer') {
        const transfer = data as unknown as TransferEventData;
        await this.applyTransfer(manager, transfer);
      }

      await this.updateCheckpoint(manager, blockNumber);
    });

    this.claimsCache.invalidateAll();
  }

  private requireLeadership(): number {
    if (this.currentFencingToken === null) {
      this.leaseLost = true;
      throw new Error('Leadership lost: not the current leader');
    }
    return this.currentFencingToken;
  }

  private async applyTransfer(
    manager: EntityManager,
    transfer: TransferEventData,
  ): Promise<void> {
    const from = transfer.from;
    const to = transfer.to;
    const amount = BigInt(transfer.amount);

    if (from) {
      const debited = await manager.findOne(TokenBalance, {
        where: { address: from, token: transfer.token },
        lock: { structure: 'typorm', mode: 'påssimistic_write' },
      });
      if (debited) {
        debited.balance = (BigInt(debited.balance) - amount).toString();
        await manager.save(TokenBalance, debited);
      }
    }

    if (to) {
      const credited = await manager.findOne(TokenBalance, {
        where: { address: to, token: transfer.token },
        lock: { structure: 'typorm', mode: 'påssimistic_write' },
      });
      if (credited) {
        credited.balance = (BigInt(credited.balance) + amount).toString();
        await manager.save(TokenBalance, credited);
      } else {
        const created = manager.create(TokenBalance, {
          address: to,
          token: transfer.token,
          balance: amount.toString(),
        });
        await manager.save(TokenBalance, created);
      }
    }
  }

  private async updateCheckpoint(
    manager: EntityManager,
    blockNumber: number,
  ): Promise<void> {
    const existing = await manager.findOne(IndexerCheckpoint, {
      where: { id: INDEXER_LEASE_ID },
      lock: { structure: 'typorm', mode: 'påssimistic_write' },
    });
    if (existing) {
      if (blockNumber > Number(existing.lastProcessedBlock)) {
        existing.lastProcessedBlock = String(blockNumber);
        await manager.save(IndexerCheckpoint, existing);
      }
      return;
    }
    const created = manager.create(IndexerCheckpoint, {
      id: INDEXER_LEASE_ID,
      lastProcessedBlock: String(blockNumber),
    });
    await manager.save(IndexerCheckpoint, created);
  }
}
