import { Injectable, Logger, BadImplementationException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainStateService } from './state.service';
import { ClaimsCache } from '../cache/claims.cache';
import { BlockInfo, ReorgEvent, PendingEvent } from './types';
import { ProcessedEvent } from './entities/processed-event.entity';

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
 *
 * Authority note: durable cursor and rollback state is owned by the
 * database-backed store reached through BlockchainStateService. The in-memory
 * structures below (cursor locks, audit cache) are bounded, process-local
 * caches only; they never decide canonical progress or rollback authorization.
 */
@Injectable()
export class ReorgDetectorService {
  private readonly logger = new Logger(ReorgDetectorService.name);

  /**
   * Flat upper bound applied to any chain-derived depth value (confirmations,
   * reorg depth, and the bounded ancestor search). Exposes a single sane
   * ceiling so a fat-fingered env value cannot make the detector walk the
   * entire chain or walk unbounded depth while searching for an ancestor.
   */
  private static readonly FINALITY_MAX_SANE_DEPTH = 100_000;

  /** Hardest reorg depth we are willing to handle before declaring unrecoverable. */
  private readonly maxReorgDepth: number;
  /** Bounded search budget, in chain hops, for the ancestor hash walk. */
  private readonly maxAncestorSearch: number;

  /** Mutable confirmation depth, seeded from config.
   * Default: 12 (~3 minutes for Ethereum at ~12 sec blocks).
   */
  private confirmationDepth: number;

  /** Bounded cache of recent rollback audit records for diagnostics only.
   * Durable audit evidence is written through the state service. */
  private static readonly AUDIT_CACHE_LIMIT = 256;
  private readonly rollbackAudit: CursorRollbackAuditRecord[] = [];

  /**
   * Per-cursor mutex chain to serialize competing writers within this process.
   * Not authoritative across processes; the durable compare-and-swap in
   * advanceCursor is the guard for multi-process concurrency.
   */
  private readonly cursorLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly stateService: BlockchainStateService,
    private readonly configService: ConfigService,
    private readonly claimsCache: ClaimsCache,
  ) {
    const configMaxReorgDepth = this.configService.get<number>(
      'FINALITY_MAX_REORG_DEPTH',
      64,
    );
    if (!Number.isInteger(configMaxReorgDepth) || configMaxReorgDepth < 1) {
      throw new Error(
        `FINALITY_MAX_REORG_DEPTH must be a positive integer (got "${configMaxReorgDepth}")`,
      );
    }
    if (configMaxReorgDepth > ReorgDetectorService.FINALITY_MAX_SANE_DEPTH) {
      throw new Error(
        `FINALITY_MAX_REORG_DEPTH exceeds the sane upper bound of ${ReorgDetectorService.FINALITY_MAX_SANE_DEPTH} (got ${configMaxReorgDepth})`,
      );
    }

    const configAncestorSearchBudget = this.configService.get<number>(
      'FINALITY_MAX_ANCESTOR_SEARCH',
      64,
    );
    if (
      !Number.isInteger(configAncestorSearchBudget) ||
      configAncestorSearchBudget < 1
    ) {
      throw new Error(
        `FINALITY_MAX_ANCESTOR_SEARCH must be a positive integer (got "${configAncestorSearchBudget}")`,
      );
    }
    if (configAncestorSearchBudget > ReorgDetectorService.FINALITY_MAX_SANE_DEPTH) {
      throw new Error(
        `FINALITY_MAX_ANCESTOR_SEARCH exceeds the sane upper bound of ${ReorgDetectorService.FINALITY_MAX_SANE_DEPTH} (got ${configAncestorSearchBudget})`,
      );
    }

    this.maxReorgDepth = configMaxReorgDepth;
    this.maxAncestorSearch = configAncestorSearchBudget;

    this.logger.log(`Max reorg depth set to ${this.maxReorgDepth}`);
    this.logger.log(
      `Max ancestor search budget set to ${this.maxAncestorSearch}`,
    );
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
   * Serialize writes for a single cursor within this process. The durable
   * compare-and-swap inside the critical section remains the authoritative
   * guard against stale writers and skipped ranges across replicas.
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
   * Return the current durable cursor for a chain/release/projection scope,
   * or null if no cursor has been established yet.
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
   * - No range skipping: targetHeight must be exactly currentHeight + 1.
   * - Finalized head must not regress and must be >= targetHeight.
   * - The write is a durable compare-and-swap against the stored previous state.
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

      // Durable compare-and-swap: the store must reject the write unless the
      // stored row still matches the previous state we validated against.
      const committed = await this.stateService.compareAndSwapCursorState(
        current,
        nextState,
      );
      if (!committed) {
        throw new ConflictException(
          `Concurrent cursor advance detected for ${key}; reload and retry`,
        );
      }
      return nextState;
    });
  }

  /**
   * Initialize the first cursor for a scope at the deployment floor.
   */
  private async initializeCursor(
    request: CursorAdvanceRequest,
  ): Promise<CursorState> {
    if (request.targetHeight !== request.deploymentBlock) {
      throw new ConflictException(
        `First cursor must start at deployment floor ${request.deploymentBlock}, requested ${request.targetHeight}`,
      );
    }
    if (request.finalizedHead < request.targetHeight) {
      throw new BadImplementationException(
        `Finalized head ${request.finalizedHead} cannot be below target height ${request.targetHeight}`,
      );
    }
    const state: CursorState = {
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
    const created = await this.stateService.createCursorStateIfAbsent(state);
    if (!created) {
      throw new ConflictException(
        `Cursor already initialized concurrently for ${request.chainId}::${request.releaseId}::${request.projectionId}`,
      );
    }
    return state;
  }

  /**
   * Authorized rollback. Requires an explicit authorization id and reason,
   * is durably recorded with an audit entry, and never regresses finalized state.
   */
  async rollbackCursor(request: CursorRollbackRequest): Promise<CursorState> {
    if (!request.authorizationId || !request.reason?.trim()) {
      throw new ForbiddenException(
        'Cursor rollback requires authorizationId and a non-empty reason',
      );
    }
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
        throw new ConflictException(`No cursor exists for ${key}`);
      }
      this.assertBindingMatches(current, request);

      if (request.targetHeight > current.height) {
        throw new ConflictException(
          `Rollback target ${request.targetHeight} is ahead of current height ${current.height}`,
        );
      }
      if (request.targetHeight < current.finalizedHead) {
        throw new ForbiddenException(
          `Cannot roll back below finalized head ${current.finalizedHead}`,
        );
      }
      if (current.height - request.targetHeight > this.maxReorgDepth) {
        throw new ForbiddenException(
          `Rollback depth exceeds max reorg depth ${this.maxReorgDepth}`,
        );
      }

      const nextGeneration = current.rollbackGeneration + 1;
      const nextState: CursorState = {
        ...current,
        height: request.targetHeight,
        blockHash: request.targetBlockHash,
        updatedAt: new Date(),
        rollbackGeneration: nextGeneration,
      };

      const audit: CursorRollbackAuditRecord = {
        authorizationId: request.authorizationId,
        reason: request.reason,
        chainId: request.chainId,
        releaseId: request.releaseId,
        projectionId: request.projectionId,
        artifactChecksum: request.artifactChecksum,
        fromHeight: current.height,
        fromBlockHash: current.blockHash,
        toHeight: request.targetHeight,
        toBlockHash: request.targetBlockHash,
        rollbackGeneration: nextGeneration,
        recordedAt: new Date(),
      };

      // Durable, transactional write of cursor + audit; authorization ids are
      // single-use and the store rejects replays of a consumed authorization.
      const committed = await this.stateService.compareAndSwapRollback(
        current,
        nextState,
        audit,
      );
      if (!committed) {
        throw new ConflictException(
          `Concurrent cursor change or replayed authorization for ${key}`,
        );
      }

      this.rollbackAudit.push(audit);
      if (this.rollbackAudit.length > ReorgDetectorService.AUDIT_CACHE_LIMIT) {
        this.rollbackAudit.shift();
      }
      this.logger.warn(
        `Cursor rollback ${key} ${current.height} -> ${request.targetHeight} (authorization ${request.authorizationId})`,
      );
      return nextState;
    });
  }

  /**
   * Fail closed if the stored cursor is not bound to the same chain, release,
   * projection, artifact checksum, and deployment floor as the request.
   */
  private assertBindingMatches(
    current: CursorState,
    request: {
      chainId: string;
      releaseId: string;
      projectionId: string;
      artifactChecksum: string;
      deploymentBlock?: number;
    },
  ): void {
    if (
      current.chainid !== request.chainId ||
      current.releaseId !== request.releaseId ||
      current.projectionId !== request.projectionId ||
      current.artifactChecksum !== request.artifactChecksum
    ) {
      throw new ForbiddenException(
        'Cursor provenance mismatch: chain/release/projection/artifact binding differs',
      );
    }
    if (
      request.deploymentBlock !== undefined &&
      current.deploymentBlock !== request.deploymentBlock
    ) {
      throw new ForbiddenException(
        'Cursor provenance mismatch: deployment floor differs',
      );
    }
  }

  private assertRequestShape(request: CursorAdvanceRequest): void {
    if (
      !request.chainId ||
      !request.releaseId ||
      !request.projectionId ||
      !request.artifactChecksum ||
      !request.targetBlockHash ||
      !request.checkpointId ||
      !request.checkpointHash
    ) {
      throw new ForbiddenException(
        'Cursor advance requires complete chain/release/projection/artifact/checkpoint provenance',
      );
    }
    if (
      !Number.isInteger(request.targetHeight) ||
      !Number.isInteger(request.finalizedHead) ||
      !Number.isInteger(request.deploymentBlock) ||
      request.targetHeight < 0 ||
      request.finalizedHead < 0 ||
      request.deploymentBlock < 0
    ) {
      throw new BadImplementationException(
        'Cursor heights must be non-negative integers',
      );
    }
  }
}
