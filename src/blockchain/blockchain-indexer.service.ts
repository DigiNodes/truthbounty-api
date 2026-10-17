import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  MoreThanOrEqual,
} from 'typeorm';
import { createHash } from 'crypto';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { DeadLetterReplay } from './entities/dead-letter-replay.entity';
import { BlockchainStateService } from './state.service';
import {
  BlockchainEvent,
  TransferEventData,
} from './interfaces/blockchain-event.interface';
import { ClaimsCache } from '../cache/claims.cache';
import { SequentialQueue } from './utils/sequential-queue';
import { ReadinessService } from '../readiness/readiness.service';

/**
 * Capability required to replay dead-lettered events. Replay is denied
 * by default; callers must present this explicit capability and a valid
 * authorisation context.
 */
export const DEAD_LETTER_REPLAY_CAPABILITY = 'blockchain:dead-letter:replay';

/** Maximum number of messages an operator may replay in a single batch. */
export const DEAD_LETTER_REPLAY_MAX_BATCH = 100;

export interface DeadLetterReplayAuthorization {
  /** Capability token the caller must hold. */
  capability: string;
  /** Operator identity recorded in the audit trail. */
  operatorId: string;
  /** Operator role claimed for the replay. */
  role?: string;
}

export interface DeadLetterReplayRequest {
  /** Ids of the dead-lettered messages to replay, in order. */
  messageIds: string[];
  /** Human-readable reason for the replay, recorded in the audit trail. */
  reason: string;
  /** Optional explicit bound on the batch size. */
  limit?: number;
  /** When true, only validates and reports what would happen. */
  dryRun: boolean;
  /** Release IDs the replay is authorised to target. */
  releaseId?: string;
  /** Schema version the replay is authorised to target. */
  schemaVersion?: string;
  /** Chain ID the replay is authorised to target. */
  chainId?: string;
  /** Original payload hash for immutable linked verification. */
  originalPayloadHash?: string;
}

export interface DeadLetterReplayResult {
  replayId: string;
  dryRun: boolean;
  requested: number;
  replayed: number;
  skipped: number;
  failed: number;
  stopped: boolean;
  details: Array<{
    messageId: string;
    status: 'replayed' | 'skipped' | 'failed' | 'dry-run';
    reason?: string;
  }>;
}

interface DeadLetterMessage {
  id: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventType: string;
  payload: unknown | null;
  payloadHash: string;
  chainId: string;
  releaseId: string;
  schemaVersion: string;
  deploymentBlock: number;
  artifactChecksum: string;
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

  /** Batch control flags for bounded replay batches. */
  private replayStopRequested = false;
  private replayResumeRequested = false;

  constructor(
    @InjectRepository(ProcessedEvent)
    private processedEventRepo: Repository<ProcessedEvent>,
    @InjectRepository(TokenBalance)
    private tokenBalanceRepo: Repository<TokenBalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    @InjectRepository(DeadLetterReplay)
    private deadLetterReplayRepo: Repository<DeadLetterReplay>,
    private dataSource: DataSource,
    private stateService: BlockchainStateService,
    private claimsCache: ClaimsCache,
    private readinessService: ReadinessService,
  ) {}

  /**
   * Process a single blockchain event. Enqueued so events are persisted one
   * at a time, in submission order.
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
        payload: data ?? null,
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

      // Advance the checkpoint inside the SAME transaction so the event, the
      // balance changes and the checkpoint all commit atomically. If anything
      // fails we roll back as a unit and the checkpoint never moves.
      await this.saveCheckpoint(queryRunner.manager, blockNumber);

      await queryRunner.commitTransaction();
      this.logger.log(`Processed event: ${eventType} at block ${blockNumber}`);

      // Record a fresh successful observation so readiness reflects the
      // indexer's liveness and projection progress. A stale last-success
      // (no recent observation) must never report healthy.
      await this.readinessService.recordIndexerObservation({
        observedAt: new Date(),
        lastSuccessAt: new Date(),
        blockNumber,
      });

      // Invalidate cache after successfully committing a projection change.
      // Passing the actual affected claim IDs (an empty array included)
      // is what makes this projection-aware: a Transfer event no longer
      // pays for (and risks the thundering-herd effect of) flushing the
      // entire claims cache on every single indexed event.
      await this.claimsCache.invalidateForProjectionUpdate(affectedClaimIds);
    } catch (error) {
      await queryRunner.rollbackTransaction();
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
      await this.stateService.recordReplay(orphaned.length);

      // A reorg invalidates prior observations: readiness must not report
      // healthy until a fresh successful observation is recorded.
      await this.readinessService.recordIndexerReorg(rewoundTo);

      // Invalidate all cache after rolling back events during a reorg
      // This is critical to ensure we never serve stale data based on orphaned chain state
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

  /**
   * Request that an in-flight bounded replay batch stop after the current
   * message. Operators can stop a batch without abruptly killing the process.
   */
  requestReplayStop(): void {
    this.replayStopRequested = true;
  }

  /** Clear a previous stop request so a new batch can proceed. */
  resumeReplay(): void {
    this.replayStopRequested = false;
    this.replayResumeRequested = true;
  }

  /**
   * Replay dead-lettered messages idempotently. Denied by default: the caller
   * must present the replay capability, a reason, bounded message IDs, a dry-run
   * flag, and a valid authorisation context. Each message is checked against
   * the current release/schema/chain and its original payload hash before being
   * replayed, and the original->replay link is persisted immutably in the
   * audit trail.
   */
  async replayDeadLetters(
    request: DeadLetterReplayRequest,
    auth?: DeadLetterReplayAuthorization,
  ): Promise<DeadLetterReplayResult> {
    // Fail closed: replay is denied by default unless the capability is
    // explicitly presented and matches the required capability token.
    if (!auth || auth.capability !== DEAD_LETTER_REPLAY_CAPABILITY) {
      throw new UnauthorizedException('Dead-letter replay requires the replay capability');
    }
    if (!auth.operatorId) {
      throw new UnauthorizedException('Dead-letter replay requires an operator identity');
    }

    // Reason is mandatory and must be meaningful.
    if (!request.reason || request.reason.trim().length < 3) {
      throw new BadRequestException('Dead-letter replay requires a non-empty reason');
    }

    // Bounds are mandatory: the caller must supply at least one message and
    // may not exceed the hard batch limit.
    if (!Array.isArray(request.messageIds) || request.messageIds.length === 0) {
      throw new BadRequestException('Dead-letter replay requires at least one message ID');
    }
    if (request.messageIds.length > DEAD_LETTER_REPLAY_MAX_BATCH) {
      throw new BadRequestException(
        `Dead-letter replay batch exceeds the maximum of ${DEAD_LETTER_REPLAY_MAX_BATCH} messages`,
      );
    }
    if (request.limit !== undefined) {
      if (!Number.isInteger(request.limit) || request.limit <= 0) {
        throw new BadRequestException('Dead-letter replay limit must be a positive integer');
      }
      if (request.limit > DEAD_LETTER_REPLAY_MAX_BATCH) {
        throw new BadRequestException(
          `Dead-letter replay limit exceeds the maximum of ${DEAD_LETTER_REPLAY_MAX_BATCH}`,
        );
      }
    }

    // Dry run is an explicit boolean flag; omitting it is ambiguous and
    // must fail closed.
    if (typeof request.dryRun !== 'boolean') {
      throw new BadRequestException('Dead-letter replay requires an explicit dryRun flag');
    }

    // Deduplicate within the request so a single call cannot replay the
    // same message twice.
    const seenIds = new Set<string>();
    const orderedIds: string[] = [];
    for (const id of request.messageIds) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        orderedIds.push(id);
      }
    }

    const effectiveLimit =
      request.limit !== undefined
        ? Math.min(request.limit, DEAD_LETTER_REPLAY_MAX_BATCH)
        : DEAD_LETTER_REPLAY_MAX_BATCH;
    const targetIds = orderedIds.slice(0, effectiveLimit);

    // Reset the resume flag for this batch; a previous stop request remains
    // honoured until the operator explicitly resumes.
    this.replayResumeRequested = false;

    const replayId = createHash('sha256')
      .update(
        `${auth.operatorId}:${request.reason}:${targetIds.join(',')}:${Date.now()}:${Math.random()}`,
      )
      .digest('hex');

    const result: DeadLetterReplayResult = {
      replayId,
      dryRun: request.dryRun,
      requested: request.messageIds.length,
      replayed: 0,
      skipped: 0,
      failed: 0,
      stopped: false,
      details: [],
    };

    // Record the audit entry for this replay attempt before any effects are
    // applied, so the intent is always auditable even if the batch fails.
    const auditRecord = this.deadLetterReplayRepo.create({
      replayId,
      operatorId: auth.operatorId,
      role: auth.role ?? null,
      reason: request.reason,
      dryRun: request.dryRun,
      requestedCount: request.messageIds.length,
      targetMessageIds: targetIds,
      chainId: request.chainId ?? null,
      releaseId: request.releaseId ?? null,
      schemaVersion: request.schemaVersion ?? null,
      originalPayloadHash: request.originalPayloadHash ?? null,
      status: 'started',
      startedAt: new Date(),
    } as DeadLetterReplay);
    await this.deadLetterReplayRepo.save(auditRecord);

    for (const messageId of targetIds) {
      // Honour an operator stop request between messages.
      if (this.replayStopRequested) {
        result.stopped = true;
        result.details.push({
          messageId,
          status: 'skipped',
          reason: 'replay stopped by operator',
        });
        result.skipped += 1;
        continue;
      }

      try {
        const outcome = await this.replayOneMessage(messageId, request, auth, replayId);
        result.details.push({
          messageId,
          status: outcome.status,
          reason: outcome.reason,
        });
        if (outcome.status === 'replayed') {
          result.replayed += 1;
        } else if (outcome.status === 'skipped') {
          result.skipped += 1;
        } else if (outcome.status === 'dry-run') {
          // Dry-run outcomes are reported but not counted as replayed.
        } else {
          result.failed += 1;
        }
      } catch (error) {
        // Partial failure: one poison message must not abort the rest of the
        // batch. Record the failure and continue.
        this.logger.error(
          `Dead-letter replay failed for message ${messageId}: ${error.message}`,
          error.stack,
        );
        result.details.push({
          messageId,
          status: 'failed',
          reason: error.message,
        });
        result.failed += 1;
      }
    }

    // Finalize the audit record with the outcome.
    await this.deadLetterReplayRepo.update(
      { replayId },
      {
        replayedCount: result.replayed,
        skippedCount: result.skipped,
        failedCount: result.failed,
        stopped: result.stopped,
        status: result.failed > 0 ? 'partial' : 'completed',
        completedAt: new Date(),
      },
    );

    return result;
  }

  private async replayOneMessage(
    messageId: string,
    request: DeadLetterReplayRequest,
    auth: DeadLetterReplayAuthorization,
    replayId: string,
  ): Promise<{ status: 'replayed' | 'skipped' | 'failed' | 'dry-run'; reason?: string }> {
    const message = await this.loadDeadLetterMessage(messageId);
    if (!message) {
      return { status: 'failed', reason: 'dead-letter message not found' };
    }

    // Reject replay across incompatible release/schema/chain boundaries.
    if (request.releaseId && request.releaseId !== message.releaseId) {
      return {
        status: 'skipped',
        reason: 'stale release: message release incompatible',
      };
    }
    if (request.schemaVersion && request.schemaVersion !== message.schemaVersion) {
      return {
        status: 'skipped',
        reason: 'stale schema: message schema incompatible',
      };
    }
    if (request.chainId && request.chainId !== message.chainId) {
      return {
        status: 'skipped',
        reason: 'chain mismatch: message chain incompatible',
      };
    }

    // Verify the original payload hash when provided. A mismatch is a
    // poison message and must not be replayed.
    if (
      request.originalPayloadHash &&
      request.originalPayloadHash !== message.payloadHash
    ) {
      return {
        status: 'failed',
        reason: 'payload hash mismatch: poison message',
      };
    }

    // Idempotency: if this message has already been replayed, skip it so
    // one message cannot produce duplicate effects.
    const alreadyReplayed = await this.deadLetterReplayRepo.findOne({
      where: { originalMessageId: messageId, status: 'replayed' },
    });
    if (alreadyReplayed) {
      return {
        status: 'skipped',
        reason: 'duplicate replay: message already replayed',
      };
    }

    if (request.dryRun) {
      return { status: 'dry-run', reason: 'would replay' };
    }

    // Apply the replay effect in a transaction and persist the immutable
    // original->replay link in the same transaction.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const event: BlockchainEvent = {
        txHash: message.txHash,
        logIndex: message.logIndex,
        blockNumber: message.blockNumber,
        eventType: message.eventType,
        data: message.payload as TransferEventData,
      };

      // Reuse the idempotent processing path so duplicate effects are
      // impossible even if the original event was already processed.
      const existing = await queryRunner.manager.findOne(ProcessedEvent, {
        where: { txHash: message.txHash, logIndex: message.logIndex },
      });
      if (!existing) {
        const processedEvent = queryRunner.manager.create(ProcessedEvent, {
          txHash: event.txHash,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber,
          eventType: event.eventType,
          payload: event.data ?? null,
        });
        await queryRunner.manager.save(ProcessedEvent, processedEvent);
        if (event.eventType === 'Transfer') {
          await this.applyTransfer(
            queryRunner.manager,
            event.data as TransferEventData,
          );
        }
      }

      // Persist the immutable link between the original message and its
      // replay. This record is the audit trail and the idempotency guard.
      const link = this.deadLetterReplayRepo.create({
        replayId,
        originalMessageId: messageId,
        operatorId: auth.operatorId,
        role: auth.role ?? null,
        reason: request.reason,
        dryRun: false,
        chainId: message.chainId,
        releaseId: message.releaseId,
        schemaVersion: message.schemaVersion,
        deploymentBlock: message.deploymentBlock,
        artifactChecksum: message.artifactChecksum,
        originalPayloadHash: message.payloadHash,
        status: 'replayed',
        startedAt: new Date(),
        completedAt: new Date(),
      } as DeadLetterReplay);
      await queryRunner.manager.save(DeadLetterReplay, link);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return { status: 'replayed' };
  }

  private async loadDeadLetterMessage(
    messageId: string,
  ): Promise<DeadLetterMessage | null> {
    // Dead-lettered messages are persisted as ProcessedEvent rows that failed
    // to apply; the message ID is the composite key of txHash:logIndex.
    const [separator, txHash, logIndexRaw] = messageId.match(/^(.+):(\d+)$/) ?? [];
    if (!separator || !txHash || logIndexRaw === undefined) {
      return null;
    }
    const logIndex = Number(logIndexRaw);
    if (!Number.isInteger(logIndex)) {
      return null;
    }

    const row = await this.processedEventRepo.findOne({
      where: { txHash, logIndex },
    });
    if (!row) {
      return null;
    }

    const payload = row.payload as unknown | null;
    const payloadHash = createHash('sha256')
      .update(payload == null ? '' : JSON.stringify(payload))
      .digest('hex');

    return {
      id: messageId,
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: row.blockNumber,
      eventType: row.eventType,
      payload,
      payloadHash,
      chainId: row.chainId ?? '',
      releaseId: row.releaseId ?? '',
      schemaVersion: row.schemaVersion ?? '',
      deploymentBlock: row.deploymentBlock ?? 0,
      artifactChecksum: row.artifactChecksum ?? '',
    };
  }

  private async applyTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    if (!data) {
      return;
    }
    const { from, to, amount, token } = data;
    await this.adjustBalance(manager, from, token, -BigInt(amount));
    await this.adjustBalance(manager, to, token, BigInt(amount));
  }

  private async reverseTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    if (!data) {
      return;
    }
    const { from, to, amount, token } = data;
    await this.adjustBalance(manager, from, token, BigInt(amount));
    await this.adjustBalance(manager, to, token, -BigInt(amount));
  }

  private async adjustBalance(
    manager: EntityManager,
    address: string,
    token: string,
    delta: bigint,
  ): Promise<void> {
    const balance = await manager.findOne(TokenBalance, {
      where: { address, token },
    });
    if (!balance) {
      await manager.save(TokenBalance, {
        address,
        token,
        balance: delta.toString(),
      });
      return;
    }
    const next = BigInt(balance.balance) + delta;
    balance.balance = next.toString();
    await manager.save(TokenBalance, balance);
  }

  private async saveCheckpoint(
    manager: EntityManager,
    blockNumber: number,
  ): Promise<void> {
    const existing = await manager.findOne(IndexerCheckpoint, {
      where: { id: 1 },
    });
    if (!existing || blockNumber > existing.lastBlock) {
      await manager.save(IndexerCheckpoint, {
        id: 1,
        lastBlock: blockNumber,
        updatedAt: new Date(),
      });
    }
  }
}
