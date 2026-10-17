import { Injectable, Logger, BadImplementationException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainStateService } from './state.service';
import { ClaimsCache } from '../cache/claims.cache';
import { BlockInfo, ReorgEvent, PendingEvent } from './types';

/**
 * Provenance metadata bound to a chain-derived cursor advancement.
 * Every advance must carry the block hash, finalized head, deployment floor,
 * and checkpoint provenance so stale or ambiguous writes fail closed.
 */
export interface CursorProvenance {
  chainId: string;
  releaseId: string;
  projectionId: string;
  artifactChecksum: string;
  deploymentBlock: number;
  blockHash: string;
  finalizedHead: number;
  checkpointId: string;
  checkpointHash: string;
}

export interface CursorState {
  height: number;
  blockHash: string;
  finalizedHead: number;
  deploymentBlock: number;
  chainid: string;
  releaseId: string;
  projectionId: string;
  artifactChecksum: string;
  checkpointId: string;
  checkpointHash: string;
  updatedAt: Date;
  rollbackGeneration: number;
}

export interface CursorAdvanceRequest {
  chainId: string;
  releaseId: string;
  projectionId: string;
  artifactChecksum: string;
  deploymentBlock: number;
  targetHeight: number;
  targetBlockHash: string;
  finalizedHead: number;
  checkpointId: string;
  checkpointHash: string;
  /** Optional expected current height for optimistic concurrency control. */
  expectedCurrentHeight?: number;
  /** Optional expected current hash for optimistic concurrency control. */
  expectedCurrentHash?: string;
}

export interface CursorRollbackRequest {
  chainId: string;
  releaseId: string;
  projectionId: string;
  artifactChecksum: string;
  targetHeight: number;
  targetBlockHash: string;
  authorizationId: string;
  reason: string;
}

export interface CursorRollbackAuditRecord {
  authorizationId: string;
  reason: string;
  chainId: string;
  releaseId: string;
  projectionId: string;
  artifactChecksum: string;
  fromHeight: number;
  fromBlockHash: string;
  toHeight: number;
  toBlockHash: string;
  rollbackGeneration: number;
  recordedAt: Date;
}

/**
 * Detects and handles chain reorganizations and enforces monotonic,
 * atomic block cursor advancement per chain/release/projection.
 */
@Injectable()
export class ReorgDetectorService {
  private readonly logger = new Logger(ReorgDetectorService.name);

  /**
   * Mutable confirmation depth, seeded from config.
   * Default: 12 (~3 minutes for Ethereum at ~12 sec blocks).
   */
  private confirmationDepth: number;

  /**
   * Authorized rollback audit trail. Rollbacks are only permitted through
   * the dedicated authorized entrypoint and are always recorded.
   */
  private readonly rollbackAudit: CursorRollbackAuditRecord[] = [];

  /**
   * Per-cursor mutex chain to serialize competing writers within this process.
   * This is not sufficient alone for multi-process concurrency; the compare-and-swap
   * in advanceCursor is the authoritative guard.
   */
  private readonly cursorLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly stateService: BlockchainStateService,
    private readonly configService: ConfigService,
    private readonly claimsCache: ClaimsCache,
  ) {
    this.confirmationDepth = this.configService.get<number>(
      'BLOCKCHAIN_CONFIRMATION_DEPTH',
      12,
    );

    this.logger.log(`Confirmation depth set to ${this.confirmationDepth}`);
  }

  /**
   * Build a stable identity key for a cursor scoped to chain/release/projection.
   */
  private cursorKey(
    chainId: string,
    releaseId: string,
    projectionId: string,
  ): string {
    return `${chainId}::${releaseId}::${projectionId}`;
  }

  /**
   * Serialize writes for a single cursor within this process. The compare-and-swap
   * inside the critical section remains the authoritative guard against stale
   * writers and skipped ranges.
   */
  private async withCursorLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cursorLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => next);
    this.cursorLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.cursorLocks.get(key) === chained) {
        this.cursorLocks.delete(key);
      }
    }
  }

  /**
   * Return the current cursor for a chain/release/projection scope, or null if no
   * cursor has been established yet.
   */
  async getCursor(
    chainId: string,
    releaseId: string,
    projectionId: string,
  ): Promise<CursorState | null> {
    const state = await this.stateService.getCursorState(
      chainId,
      releaseId,
      projectionId,
    );
    return state ?? null;
  }

  /**
   * Atomically advance the cursor for a chain/release/projection scope.
   *
   * Guarantees:
   * - Monotonic forward only; any target at or below the current height is rejected
   *   unless it is an identical replay (no-op).
   * - Same height with a different hash fails closed as a conflict.
   * - Wrong release/projection/checksum/chain binding fails closed.
   * - No range skipping: targetHeight must be exactly currentHeight + 1 on the
   *   first advance (from deployment floor) and on every subsequent advance.
   * - Finalized head must not regress and must be >= targetHeight.
   */
  async advanceCursor(request: CursorAdvanceRequest): Promise<CursorState> {
    this.assertRequestShape(request);

    const key = this.cursorKey(
      request.chainId,
      request.releaseId,
      request.projectionId,
    );

    return this.withCursorLock(key, async () => {
      const current = await this.stateService.getCursorState(
        request.chainId,
        request.releaseId,
        request.projectionId,
      );

      if (!current) {
        return this.initializeCursor(request);
      }

      this.assertBindingMatches(current, request);

      // Optimistic concurrency: callers may pin the expected current state.
      // Any disagreement means another writer advanced first -> stale writer.
      if (
        request.expectedCurrentHeight !== undefined &&
        request.expectedCurrentHeight !== current.height
      ) {
        throw new ConflictException(
          `Stale cursor writer: expected height ${request.expectedCurrentHeight} but current is ${current.height}`,
        );
      }
      if (
        request.expectedCurrentHash !== undefined &&
        request.expectedCurrentHash !== current.blockHash
      ) {
        throw new ConflictException(
          `Stale cursor writer: expected hash ${request.expectedCurrentHash} but current is ${current.blockHash}`,
        );
      }

      // Identical replay (no-op): same height, same hash, same finalized head.
      // This is not a movement and is safe to acknowledge.
      if (
        request.targetHeight === current.height &&
        request.targetBlockHash === current.blockHash
      ) {
        if (request.finalizedHead < current.finalizedHead) {
          throw new ConflictException(
            `Finalized head cannot regress: current ${current.finalizedHead}, requested ${request.finalizedHead}`,
          );
        }
        return current;
      }

      // Same height, different hash => conflict. Hash disagreement fails closed.
      if (request.targetHeight === current.height) {
        throw new ConflictException(
          `Hash disagreement at height ${current.height}: current ${current.blockHash}, requested ${request.targetBlockHash}`,
        );
      }

      // Backward movement is only possible through the authorized rollback path.
      if (request.targetHeight < current.height) {
        throw new ConflictException(
          `Cursor cannot move backward outside explicit rollback: current ${current.height}, requested ${request.targetHeight}`,
        );
      }

      // No range skipping: the target must be exactly the next block.
      if (request.targetHeight !== current.height + 1) {
        throw new ConflictException(
          `Cursor advance would skip ranges: current ${current.height}, requested ${request.targetHeight}`,
        );
      }

      // Finalized head must not regress and must cover the target.
      if (request.finalizedHead < current.finalizedHead) {
        throw new ConflictException(
          `Finalized head cannot regress: current ${current.finalizedHead}, requested ${request.finalizedHead}`,
        );
      }
      if (request.finalizedHead < request.targetHeight) {
        throw new BadImplementationException(
          `Finalized head ${request.finalizedHead} cannot be below target height ${request.targetHeight}`,
        );
      }

      // Checkpoint provenance must move monotonically with the cursor.
      if (
        request.checkpointHash === current.checkpointHash &&
        request.checkpointId !== current.checkpointId
      ) {
        throw new ConflictException(
          `Checkpoint hash collision across different checkpoint ids: ${current.checkpointId} vs ${request.checkpointId}`,
        );
      }

      const nextState: CursorState = {
        height: request.targetHeight,
        blockHash: request.targetBlockHash,
        finalizedHead: request.finalizedHead,
        deploymentBlock: current.deploymentBlock,
        chainid: current.chainid,
        releaseId: current.releaseId,
        projectionId: current.projectionId,
        artifactChecksum: current.artifactChecksum,
        checkpointId: request.checkpointId,
        checkpointHash: request.checkpointHash,
        updatedAt: new Date(),
        rollbackGeneration: current.rollbackGeneration,
      };

      // Atomic compare-and-swap: the state layer must reject the write if the
      // current stored state no longer matches the expected previous state.
      const committed = await this.stateService.compareAndSwapCursorState(
        {
          chainId: current.chainid,
          releaseId: current.releaseId,
          projectionId: current.projectionId,
        },
        {
          height: current.height,
          blockHash: current.blockHash,
        },
        nextState,
      );

      if (!committed) {
        throw new ConflictException(
          `Concurrent cursor writer detected for ${key}; compare-and-swap rejected`,
        );
      }

      this.logger.log(
        `Cursor advanced for ${key} to height ${nextState.height} (${nextState.blockHash})`,
      );
      return nextState;
    });
  }

  /**
   * Explicitly authorized rollback. This is the only path allowed to move the
   * cursor backward. Requires an authorization ID and a reason, and records an
   * audit entry for the transition.
   */
  async rollbackCursor(request: CursorRollbackRequest): Promise<CursorState> {
    this.assertRollbackRequestShape(request);

    const key = this.cursorKey(
      request.chainId,
      request.releaseId,
      request.projectionId,
    );

    return this.withCursorLock(key, async () => {
      const current = await this.stateService.getCursorState(
        request.chainId,
        request.releaseId,
        request.projectionId,
      );

      if (!current) {
        throw new BadImplementationException(
          `Cannot rollback cursor ${key}: no cursor exists`,
        );
      }

      this.assertBindingMatches(current, {
        chainId: request.chainId,
        releaseId: request.releaseId,
        projectionId: request.projectionId,
        artifactChecksum: request.artifactChecksum,
      });

      if (request.targetHeight >= current.height) {
        throw new BadImplementationException(
          `Rollback target ${request.targetHeight} must be below current height ${current.height}`,
        );
      }
      if (request.targetHeight < current.deploymentBlock) {
        throw new BadImplementationException(
          `Rollback target ${request.targetHeight} is below deployment floor ${current.deploymentBlock}`,
        );
      }

      const nextGeneration = current.rollbackGeneration + 1;
      const nextState: CursorState = {
        height: request.targetHeight,
        blockHash: request.targetBlockHash,
        finalizedHead: Math.min(current.finalizedHead, request.targetHeight),
        deploymentBlock: current.deploymentBlock,
        chainid: current.chainid,
        releaseId: current.releaseId,
        projectionId: current.projectionId,
        artifactChecksum: current.artifactChecksum,
        checkpointId: current.checkpointId,
        checkpointHash: current.checkpointHash,
        updatedAt: new Date(),
        rollbackGeneration: nextGeneration,
      };

      const committed = await this.stateService.compareAndSwapCursorState(
        {
          chainId: current.chainid,
          releaseId: current.releaseId,
          projectionId: current.projectionId,
        },
        {
          height: current.height,
          blockHash: current.blockHash,
        },
        nextState,
      );

      if (!committed) {
        throw new ConflictException(
          `Concurrent cursor writer detected during rollback for ${key}; compare-and-swap rejected`,
        );
      }

      const audit: CursorRollbackAuditRecord = {
        authorizationId: request.authorizationId,
        reason: request.reason,
        chainId: current.chainid,
        releaseId: current.releaseId,
        projectionId: current.projectionId,
        artifactChecksum: current.artifactChecksum,
        fromHeight: current.height,
        fromBlockHash: current.blockHash,
        toHeight: nextState.height,
        toBlockHash: nextState.blockHash,
        rollbackGeneration: nextGeneration,
        recordedAt: new Date(),
      };
      this.rollbackAudit.push(audit);

      await this.stateService.recordCursorRollbackAudit(audit);

      this.logger.warn(
        `Cursor rollback for ${key} from ${current.height} to ${nextState.height} authorized by ${request.authorizationId}`,
      );
      return nextState;
    });
  }

  /**
   * Return a copy of the rollback audit trail recorded by this service instance.
   */
  getRollbackAuditTrail(): CursorRollbackAuditRecord[] {
    return this.rollbackAudit.map((record) => ({ ...record }));
  }

  private async initializeCursor(
    request: CursorAdvanceRequest,
  ): Promise<CursorState> {
    // The first advance must land on the deployment floor or the block immediately
    // after it. This prevents a writer from skipping the deployment floor.
    if (request.targetHeight !== request.deploymentBlock + 1) {
      throw new BadImplementationException(
        `Initial cursor advance must be deployment floor + 1 (${request.deploymentBlock + 1}), received ${request.targetHeight}`,
      );
    }
    if (request.finalizedHead < request.targetHeight) {
      throw new BadImplementationException(
        `Finalized head ${request.finalizedHead} cannot be below target height ${request.targetHeight}`,
      );
    }

    const initialState: CursorState = {
      height: request.targetHeight,
      blockHash: request.targetBlockHash,
      finalizedHead: request.finalizedHead,
      deploymentBlock: request.deploymentBlock,
      chainid: request.chainId,
      releaseId: request.releaseId,
      projectionId: request.projectionId,
      artifactChecksum: request.artifactChecksum,
      checkpointId: request.checkpointId,
      checkpointHash: request.checkpointHash,
      updatedAt: new Date(),
      rollbackGeneration: 0,
    };

    const committed = await this.stateService.compareAndSwapCursorState(
      {
        chainId: request.chainId,
        releaseId: request.releaseId,
        projectionId: request.projectionId,
      },
      null,
      initialState,
    );

    if (!committed) {
      throw new ConflictException(
        `Concurrent cursor initialization detected for ${request.chainId}::${request.releaseId}::${request.projectionId}; compare-and-swap rejected`,
      );
    }

    this.logger.log(
      `Cursor initialized for ${request.chainId}::${request.releaseId}::${request.projectionId} at height ${initialState.height}`,
    );
    return initialState;
  }

  private assertRequestShape(request: CursorAdvanceRequest): void {
    this.assertNonEmptyString(request.chainId, 'chainId');
    this.assertNonEmptyString(request.releaseId, 'releaseId');
    this.assertNonEmptyString(request.projectionId, 'projectionId');
    this.assertNonEmptyString(request.artifactChecksum, 'artifactChecksum');
    this.assertNonEmptyString(request.targetBlockHash, 'targetBlockHash');
    this.assertNonEmptyString(request.checkpointId, 'checkpointId');
    this.assertNonEmptyString(request.checkpointHash, 'checkpointHash');
    this.assertNonNegativeInteger(request.deploymentBlock, 'deploymentBlock');
    this.assertPositiveInteger(request.targetHeight, 'targetHeight');
    this.assertNonNegativeInteger(request.finalizedHead, 'finalizedHead');
  }

  private assertRollbackRequestShape(request: CursorRollbackRequest): void {
    this.assertNonEmptyString(request.chainId, 'chainId');
    this.assertNonEmptyString(request.releaseId, 'releaseId');
    this.assertNonEmptyString(request.projectionId, 'projectionId');
    this.assertNonEmptyString(request.artifactChecksum, 'artifactChecksum');
    this.assertNonEmptyString(request.targetBlockHash, 'targetBlockHash');
    this.assertNonEmptyString(request.authorizationId, 'authorizationId');
    this.assertNonEmptyString(request.reason, 'reason');
    this.assertPositiveInteger(request.targetHeight, 'targetHeight');
  }

  private assertBindingMatches(
    current: CursorState,
    request: Pick<
      CursorAdvanceRequest,
      'chainId' | 'releaseId' | 'projectionId' | 'artifactChecksum'
    >,
  ): void {
    if (current.chainid !== request.chainId) {
      throw new ForbiddenException(
        `Cursor chain binding mismatch: stored ${current.chainid}, requested ${request.chainId}`,
      );
    }
    if (current.releaseId !== request.releaseId) {
      throw new ForbiddenException(
        `Cursor release binding mismatch: stored ${current.releaseId}, requested ${request.releaseId}`,
      );
    }
    if (current.projectionId !== request.projectionId) {
      throw new ForbiddenException(
        `Cursor projection binding mismatch: stored ${current.projectionId}, requested ${request.projectionId}`,
      );
    }
    if (current.artifactChecksum !== request.artifactChecksum) {
      throw new ForbiddenException(
        `Cursor artifact checksum mismatch: stored ${current.artifactChecksum}, requested ${request.artifactChecksum}`,
      );
    }
  }

  private assertNonEmptyString(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadImplementationException(`${field} must be a non-empty string`);
    }
  }

  private assertNonNegativeInteger(value: unknown, field: string): void {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new BadImplementationException(
        `${field} must be a non-negative integer`,
      );
    }
  }

  private assertPositiveInteger(value: unknown, field: string): void {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new BadImplementationException(`${field} must be a positive integer`);
    }
  }

  /**
   * Check if a reorg has occurred by comparing block hashes.
   * Returns detected reorg information or null if no reorg.
   */
  async detectReorg(
    currentBlock: BlockInfo,
    previousBlockNumber: number,
  ): Promise<ReorgEvent | null> {
    if (previousBlockNumber === 0) {
      return null; // First block, no reorg possible
    }

    const expectedParent =
      await this.stateService.getCanonicalBlock(previousBlockNumber);

    if (!expectedParent) {
      return null;
    }

    if (expectedParent.blockHash === currentBlock.parentHash) {
      return null;
    }

    this.logger.warn(
      `Reorg detected! Current parent hash: ${currentBlock.parentHash}, ` +
        `expected: ${expectedParent.blockHash}`,
    );

    const reorgDepth = await this.findDivergencePoint(currentBlock);
    const affectedBlockStart = previousBlockNumber - reorgDepth + 1;
    const affectedBlockEnd = previousBlockNumber;

    const affectedEvents = await this.getAffectedEvents(
      affectedBlockStart,
      affectedBlockEnd,
    );
    const orphanedEventIds = affectedEvents.map((e) => e.id);

    const reorg: ReorgEvent = {
      detectedAt: new Date(),
      reorgDepth,
      affectedBlockStart,
      affectedBlockEnd,
      orphanedEvents: orphanedEventIds,
      reprocessedEvents: [],
    };

    this.logger.warn(
      `Reorg of depth ${reorgDepth} detected. ` +
        `Affected blocks: ${affectedBlockStart}-${affectedBlockEnd}. ` +
        `Orphaned events: ${orphanedEventIds.length}`,
    );

    // Invalidate all cached claims since blockchain state has changed
    // This maintains the invariant that smart contracts are always the source of truth
    await this.claimsCache.invalidateBlockRange(
      affectedBlockStart,
      affectedBlockEnd,
    );

    return reorg;
  }

  /**
   * Find the exact divergence point in the chain.
   */
  private async findDivergencePoint(currentBlock: BlockInfo): Promise<number> {
    let divergenceDepth = 0;
    let checkBlockNumber = currentBlock.number;

    // Walk backwards through the chain to find where it diverges
    // We compare the expected hash in our current chain at each depth
    // with the canonical block at that height
    while (checkBlockNumber > 0 && divergenceDepth <= 1000) {
      const canonicalBlock =
        await this.stateService.getCanonicalBlock(checkBlockNumber);

      if (
        canonicalBlock &&
        canonicalBlock.blockHash !== currentBlock.parentHash
      ) {
        divergenceDepth++;
        checkBlockNumber--;
      } else {
        // Calculate what the block hash should be at this depth in our current chain
        let expectedHash: string;
        if (divergenceDepth === 0) {
          // At depth 0, we're looking at the current block itself
          expectedHash = currentBlock.hash;
        } else {
          // For depth > 0, we need to get the ancestor at this depth
          expectedHash = await this.getAncestorHashAtDepth(
            currentBlock,
            divergenceDepth,
          );
        }

        // If we don't have a canonical block at this height, or the hashes don't match,
        // we've found the divergence point (the first block where they don't match)
        if (!canonicalBlock || canonicalBlock.blockHash !== expectedHash) {
          // Found the point where chains diverge
          break;
        } else {
          // Chains still match, go deeper (check next block back)
          divergenceDepth++;
          checkBlockNumber--;
        }
      }
    }

    return divergenceDepth;
  }

  /**
   * Get the hash of the ancestor at a specific depth from the current block
   * @param currentBlock The current block to start from
   * @param depth How many blocks back to go (0 = current block, 1 = parent, 2 = grandparent, etc.)
   * @returns The hash of the ancestor at the specified depth
   */
  private async getAncestorHashAtDepth(
    currentBlock: BlockInfo,
    depth: number,
  ): Promise<string> {
    if (depth < 0) {
      throw new Error('Depth must be >= 0');
    }

    // For depth 0, we're at the current block
    if (depth === 0) {
      return currentBlock.hash;
    }

    // Start with the current block
    let hash = currentBlock.hash;
    let currentDepth = 0;

    // Traverse back 'depth' times to get the ancestor at that depth
    while (currentDepth < depth) {
      const block = await this.stateService.getCanonicalBlockByHash(hash);
      if (!block) {
        // If we can't find the block, return empty string to force mismatch
        return '';
      }
      hash = block.parentHash;
      currentDepth++;
    }

    return hash;
  }
  private async getAffectedEvents(
    startBlock: number,
    endBlock: number,
  ): Promise<PendingEvent[]> {
    const affectedEvents: PendingEvent[] = [];

    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      const blockEvents = await this.stateService.getEventsByBlock(blockNum);
      affectedEvents.push(...blockEvents);
    }

    return affectedEvents;
  }

  /**
   * Calculate confirmation count for an event.
   */
  async calculateConfirmations(
    blockNumber: number,
    headBlockNumber: number,
  ): Promise<number> {
    return Math.max(0, headBlockNumber - blockNumber);
  }

  /**
   * Check if an event is sufficiently confirmed.
   */
  async isEventConfirmed(
    blockNumber: number,
    headBlockNumber: number,
  ): Promise<boolean> {
    const confirmations = await this.calculateConfirmations(
      blockNumber,
      headBlockNumber,
    );
    return confirmations >= this.confirmationDepth;
  }

  /**
   * Get the current confirmation depth requirement.
   */
  getConfirmationDepth(): number {
    return this.confirmationDepth;
  }

  /**
   * Set a custom confirmation depth at runtime.
   * Useful for testing or operator overrides.
   */
  setConfirmationDepth(depth: number): void {
    if (depth < 1) {
      throw new Error('Confirmation depth must be at least 1');
    }
    this.confirmationDepth = depth;
    this.logger.log(`Confirmation depth updated to ${depth}`);
  }
}
