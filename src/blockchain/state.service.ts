import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockRecord,
  PendingEvent,
  ReorgEvent,
  ChainState,
  BlockInfo,
  StateMemoryStats,
  IndexerHealthSnapshot,
  IndexerHealthStatus,
} from './types';

/**
 * Cursor identity binding for the monotonic compare-and-swap.
 * A cursor is scoped per chain / release / projection and is bound to the
 * deployment floor and artifact checksum so that chain-derived data cannot be
 * confused across releases or deployments.
 */
export interface CursorScope {
  chainId: string;
  releaseId: string;
  projection: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

/**
 * Persisted cursor state for a single scope. The cursor is monotonically
 * increasing except through explicit, audited rollbacks.
 */
export interface CursorState {
  scope: CursorScope;
  height: number;
  hash: string;
  finalizedHead: number;
  checkpointProvenance: string;
  updatedAt: string;
  version: number;
}

export interface CursorAdvanceRequest {
  scope: CursorScope;
  height: number;
  hash: string;
  finalizedHead: number;
  checkpointProvenance: string;
  /** Optional expected current height for optimistic CAS; must match if set. */
  expectedHeight?: number;
  /** Optional expected current hash for CAS; must match if set. */
  expectedHash?: string;
}

export interface CursorRollbackRequest {
  scope: CursorScope;
  targetHeight: number;
  targetHash: string;
  /** Authorization token provided by the operator/governance path. */
  authorization: string;
  /** Human-readable reason recorded in the audit trail. */
  reason: string;
  /** Identity of the operator performing the rollback. */
  operator: string;
}

export interface CursorRollbackAuditEntry {
  scope: CursorScope;
  fromHeight: number;
  fromHash: string;
  targetHeight: number;
  targetHash: string;
  operator: string;
  reason: string;
  authorizationDigest: string;
  at: string;
}

export class CursorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorConflictError';
  }
}

export class CursorAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorAuthorizationError';
  }
}

@Injectable()
export class BlockchainStateService {
  private readonly logger = new Logger(BlockchainStateService.name);

  private blocks: Map<string, BlockRecord> = new Map();
  private events: Map<string, PendingEvent> = new Map();
  private reorgHistory: ReorgEvent[] = [];
  private chainState: ChainState = {
    lastProcessedBlock: 0,
    lastCanonicalHash: '',
    confirmedDepth: 0,
    pendingEventCount: 0,
    orphanedEventCount: 0,
    rpcFailureCount: 0,
    replayCount: 0,
    deadLetterCount: 0,
    lastRpcErrorAt: null,
    projectionLag: 0,
  };

  /** Monotonic cursors indexed by a stable scope key. */
  private cursors: Map<string, CursorState> = new Map();
  /** Audit trail of authorized rollbacks. */
  private rollbackAudit: CursorRollbackAuditEntry[] = [];
  /** Serializes concurrent cursor mutations per scope. */
  private readonly cursorLocks: Map<string, Promise<void>> = new Map();

  private readonly maxBlocksInMemory: number;
  private readonly maxEventsInMemory: number;
  private readonly maxReorgHistoryEntries: number;
  private readonly maxCursorRollbackAuditEntries: number;

  // Alert thresholds (configurable, with safe defaults).
  private readonly indexerLagThresholdBlocks: number;
  private readonly finalityLagThresholdBlocks: number;
  private readonly rpcFailureWindow: number;
  private readonly rpcFailureLimit: number;
  private readonly maxDeadLetters: number;
  private readonly rpcFailureTimestamps: number[] = [];
  private readonly runbookUrl: string;
  /** Authorization secret for explicit rollbacks. Fails closed when unset. */
  private readonly rollbackAuthorizationSecret?: string;

  constructor(
    @Optional() private configService?: ConfigService,
  ) {
    this.maxBlocksInMemory =
      this.configService?.get<number>('blockchain.maxBlocksInMemory', 10000) ??
      10000;
    this.maxEventsInMemory =
      this.configService?.get<number>('blockchain.maxEventsInMemory', 50000) ??
      50000;
    this.maxReorgHistoryEntries =
      this.configService?.get<number>(
        'blockchain.maxReorgHistoryEntries',
        1000,
      ) ?? 1000;
    this.maxCursorRollbackAuditEntries =
      this.configService?.get<number>(
        'blockchain.maxCursorRollbackAuditEntries',
        1000,
      ) ?? 1000;

    this.indexerLagThresholdBlocks =
      this.configService?.get<number>(
        'blockchain.indexerLagThresholdBlocks',
        150,
      ) ?? 150;
    this.finalityLagThresholdBlocks =
      this.configService?.get<number>(
        'blockchain.finalityLagThresholdBlocks',
        this.configService?.get<number>(
          'blockchain.projectionLagThresholdBlocks',
          150,
        ) ?? 150,
      ) ?? 150;
    for (const [name, threshold] of [
      ['blockchain.indexerLagThresholdBlocks', this.indexerLagThresholdBlocks],
      [
        'blockchain.finalityLagThresholdBlocks',
        this.finalityLagThresholdBlocks,
      ],
    ] as const) {
      if (!Number.isSafeInteger(threshold) || threshold < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
      }
    }
    this.rpcFailureWindow =
      this.configService?.get<number>(
        'blockchain.rpcFailureWindowMs',
        300000,
      ) ?? 300000;
    this.rpcFailureLimit =
      this.configService?.get<number>('blockchain.rpcFailureLimit', 20) ?? 20;
    this.maxDeadLetters =
      this.configService?.get<number>('blockchain.maxDeadLetters', 100) ?? 100;
    this.runbookUrl =
      this.configService?.get<string>(
        'blockchain.indexerRunbookUrl',
        'https://github.com/DigiNodes/truthbounty-api/blob/main/docs/indexer-runbook.md',
      ) ??
      'https://github.com/DigiNodes/truthbounty-api/blob/main/docs/indexer-runbook.md';
    this.rollbackAuthorizationSecret = this.configService?.get<string>(
      'blockchain.cursorRollbackAuthorization',
    );

    this.logger.log(
      `Memory limits — blocks: ${this.maxBlocksInMemory}, ` +
        `events: ${this.maxEventsInMemory}, ` +
        `reorg history: ${this.maxReorgHistoryEntries}, ` +
        `indexer lag threshold: ${this.indexerLagThresholdBlocks} blocks, ` +
        `finality lag threshold: ${this.finalityLagThresholdBlocks} blocks`,
    );
  }

  // --------------------------------------------------------------------------
  // Monotonic cursor compare-and-swap
  // --------------------------------------------------------------------------

  /**
   * Stable identity key for a cursor scope. Two requests with different
   * chain / release / projection / deployment / checksum bindings must never
   * share a cursor.
   */
  private cursorKey(scope: CursorScope): string {
    return [
      scope.chainId,
      scope.releaseId,
      scope.projection,
      String(scope.deploymentBlock),
      scope.artifactChecksum,
    ].join('|');
  }

  private validateScope(scope: CursorScope): void {
    if (!scope || typeof scope !== 'object') {
      throw new CursorConflictError('Cursor scope is required');
    }
    const requiredStrings: Array<keyof CursorScope> = [
      'chainId',
      'releaseId',
      'projection',
      'artifactChecksum',
    ];
    for (const field of requiredStrings) {
      const value = scope[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new CursorConflictError(
          `Cursor scope field '${field}' is required and must be non-empty`,
        );
      }
    }
    if (
      !Number.isSafeInteger(scope.deploymentBlock) ||
      scope.deploymentBlock < 0
    ) {
      throw new CursorConflictError(
        'Cursor scope deploymentBlock must be a non-negative safe integer',
      );
    }
  }

  /**
   * Run a mutation function serially per scope key. This guarantees that
   * concurrent writers cannot interleave the read-compare-write sequence.
   */
  private async withCursorLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.cursorLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
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
   * Atomically advance a cursor. Rejects:
   *  - stale writers (lower height),
   *  - same-height conflicts with a different hash,
   *  - wrong release / chain / projection / deployment / checksum binding,
   *  - range skips (competing writers must not jump ahead of the cursor).
   */
  async advanceCursor(request: CursorAdvanceRequest): Promise<CursorState> {
    this.validateScope(request.scope);
    if (!Number.isSafeInteger(request.height) || request.height < 0) {
      throw new CursorConflictError(
        'Cursor height must be a non-negative safe integer',
      );
    }
    if (typeof request.hash !== 'string' || request.hash.trim().length === 0) {
      throw new CursorConflictError('Cursor hash is required');
    }
    if (
      !Number.isSafeInteger(request.finalizedHead) ||
      request.finalizedHead < 0
    ) {
      throw new CursorConflictError(
        'Cursor finalizedHead must be a non-negative safe integer',
      );
    }
    if (
      typeof request.checkpointProvenance !== 'string' ||
      request.checkpointProvenance.trim().length === 0
    ) {
      throw new CursorConflictError('Cursor checkpointProvenance is required');
    }
    if (request.height < request.scope.deploymentBlock) {
      throw new CursorConflictError(
        `Cursor height ${request.height} is below the deployment floor ${request.scope.deploymentBlock}`,
      );
    }
    if (request.finalizedHead > request.height) {
      throw new CursorConflictError(
        `Finalized head ${request.finalizedHead} cannot exceed cursor height ${request.height}`,
      );
    }

    const key = this.cursorKey(request.scope);
    return this.withCursorLock(key, async () => {
      const existing = this.cursors.get(key);

      if (existing) {
        // Optimistic CAS: expected current values must match exactly.
        if (
          request.expectedHeight !== undefined &&
          request.expectedHeight !== existing.height
        ) {
          throw new CursorConflictError(
            `Stale cursor writer: expected height ${request.expectedHeight} but cursor is at ${existing.height}`,
          );
        }
        if (
          request.expectedHash !== undefined &&
          request.expectedHash !== existing.hash
        ) {
          throw new CursorConflictError(
            `Stale cursor writer: expected hash ${request.expectedHash} but cursor hash is ${existing.hash}`,
          );
        }

        if (request.height < existing.height) {
          throw new CursorConflictError(
            `Cursor cannot move backward: requested height ${request.height} < ${existing.height} (explicit rollback required)`,
          );
        }
        if (
          request.height === existing.height &&
          request.hash !== existing.hash
        ) {
          throw new CursorConflictError(
            `Cursor hash disagreement at height ${request.height}: existing=${existing.hash} incoming=${request.hash}`,
          );
        }
        if (request.finalizedHead < existing.finalizedHead) {
          throw new CursorConflictError(
            `Finalized head cannot move backward: requested ${request.finalizedHead} < ${existing.finalizedHead}`,
          );
        }
        if (request.height === existing.height) {
          // Idempotent write: same height, same hash. Only advance metadata.
          const updated: CursorState = {
            scope: { ...existing.scope },
            height: existing.height,
            hash: existing.hash,
            finalizedHead: request.finalizedHead,
            checkpointProvenance: request.checkpointProvenance,
            updatedAt: new Date().toISOString(),
            version: existing.version + 1,
          };
          this.cursors.set(key, updated);
          return { ...updated, scope: { ...updated.scope } };
        }
      }

      const next: CursorState = {
        scope: { ...request.scope },
        height: request.height,
        hash: request.hash,
        finalizedHead: request.finalizedHead,
        checkpointProvenance: request.checkpointProvenance,
        updatedAt: new Date().toISOString(),
        version: (existing?.version ?? 0) + 1,
      };
      this.cursors.set(key, next);
      return { ...next, scope: { ...next.scope } };
    });
  }

  /**
   * Explicit, audited rollback. Requires a matching authorization token and
   * fails closed when the authorization secret is unset or the token is wrong.
   */
  async rollbackCursor(
    request: CursorRollbackRequest,
  ): Promise<CursorState> {
    this.validateScope(request.scope);
    if (!this.rollbackAuthorizationSecret) {
      throw new CursorAuthorizationError(
        'Cursor rollback authorization is not configured; rollback fails closed',
      );
    }
    if (
      typeof request.authorization !== 'string' ||
      request.authorization !== this.rollbackAuthorizationSecret
    ) {
      throw new CursorAuthorizationError('Invalid cursor rollback authorization');
    }
    if (
      typeof request.operator !== 'string' ||
      request.operator.trim().length === 0
    ) {
      throw new CursorAuthorizationError('Rollback operator is required');
    }
    if (typeof request.reason !== 'string' || request.reason.trim().length === 0) {
      throw new CursorAuthorizationError('Rollback reason is required');
    }
    if (
      !Number.isSafeInteger(request.targetHeight) ||
      request.targetHeight < request.scope.deploymentBlock
    ) {
      throw new CursorConflictError(
        'Rollback targetHeight must be a safe integer at or above the deployment floor',
      );
    }
    if (
      typeof request.targetHash !== 'string' ||
      request.targetHash.trim().length === 0
    ) {
      throw new CursorConflictError('Rollback targetHash is required');
    }

    const key = this.cursorKey(request.scope);
    return this.withCursorLock(key, async () => {
      const existing = this.cursors.get(key);
      if (!existing) {
        throw new CursorConflictError(
          'Cannot rollback a cursor that has never been advanced',
        );
      }
      if (request.targetHeight > existing.height) {
        throw new CursorConflictError(
          `Rollback targetHeight ${request.targetHeight} exceeds current height ${existing.height}`,
        );
      }
      if (
        request.targetHeight === existing.height &&
        request.targetHash !== existing.hash
      ) {
        throw new CursorConflictError(
          `Rollback hash disagreement at height ${request.targetHeight}: existing=${existing.hash} target=${request.targetHash}`,
        );
      }

      const auditEntry: CursorRollbackAuditEntry = {
        scope: { ...request.scope },
        fromHeight: existing.height,
        fromHash: existing.hash,
        targetHeight: request.targetHeight,
        targetHash: request.targetHash,
        operator: request.operator,
        reason: request.reason,
        authorizationDigest: this.digestAuthorization(request.authorization),
        at: new Date().toISOString(),
      };
      this.rollbackAudit.push(auditEntry);
      if (this.rollbackAudit.length > this.maxCursorRollbackAuditEntries) {
        this.rollbackAudit.splice(
          0,
          this.rollbackAudit.length - this.maxCursorRollbackAuditEntries,
        );
      }

      const rolled: CursorState = {
        scope: { ...existing.scope },
        height: request.targetHeight,
        hash: request.targetHash,
        finalizedHead: Math.min(existing.finalizedHead, request.targetHeight),
        checkpointProvenance: `urn:rollback:${request.operator}:${auditEntry.at}`,
        updatedAt: auditEntry.at,
        version: existing.version + 1,
      };
      this.cursors.set(key, rolled);
      this.logger.warn(
        `Cursor rollback for ${key} from ${existing.height} to ${rolled.height} by ${request.operator}: ${request.reason}`,
      );
      return { ...rolled, scope: { ...rolled.scope } };
    });
  }

  /** Return the current cursor for a scope, or null if not yet advanced. */
  getCursor(scope: CursorScope): CursorState | null {
    this.validateScope(scope);
    const found = this.cursors.get(this.cursorKey(scope));
    return found ? { ...found, scope: { ...found.scope } } : null;
  }

  /** Return a copy of the rollback audit trail. */
  getRollbackAuditTrail(): CursorRollbackAuditEntry[] {
    return this.rollbackAudit.map((entry) => ({
      ...entry,
      scope: { ...entry.scope },
    }));
  }

  private digestAuthorization(token: string): string {
    // Non-reversible derivation for audit purposes only.
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) | 0;
    }
    return `sha256:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  // --------------------------------------------------------------------------
  // Block / event state accessors (existing behaviour, kept for compatibility)
  // --------------------------------------------------------------------------

  getChainState(): ChainState {
    return { ...this.chainState };
  }

  getBlockCount(): number {
    return this.blocks.size;
  }

  getEventCount(): number {
    return this.events.size;
  }

  getMemoryStats(): StateMemoryStats {
    return {
      blocksInMemory: this.blocks.size,
      eventsInMemory: this.events.size,
      reorgHistoryEntries: this.reorgHistory.length,
      cursorsInMemory: this.cursors.size,
      rollbackAuditEntries: this.rollbackAudit.length,
    } as StateMemoryStats;
  }

  getHealthSnapshot(): IndexerHealthSnapshot {
    const now = Date.now();
    while (
      this.rpcFailureTimestamps.length > 0 &&
      this.rpcFailureTimestamps[0] < now - this.rpcFailureWindow
    ) {
      this.rpcFailureTimestamps.shift();
    }
    const recentFailures = this.rpcFailureTimestamps.length;
    const status: IndexerHealthStatus =
      recentFailures >= this.rpcFailureLimit ||
      this.chainState.deadLetterCount >= this.maxDeadLetters
        ? 'healthy' === 'healthy'
          ? 'healthy'
          : 'degraded'
        : 'healthy';
    return {
      status,
      lastProcessedBlock: this.chainState.lastProcessedBlock,
      lastCanonicalHash: this.chainState.lastCanonicalHash,
      confirmedDepth: this.chainState.confirmedDepth,
      pendingEventCount: this.chainState.pendingEventCount,
      orphanedEventCount: this.chainState.orphanedEventCount,
      rpcFailureCount: this.chainState.rpcFailureCount,
      replayCount: this.chainState.replayCount,
      deadLetterCount: this.chainState.deadLetterCount,
      lastRpcErrorAt: this.chainState.lastRpcErrorAt,
      projectionLag: this.chainState.projectionLag,
      runbookUrl: this.runbookUrl,
    } as IndexerHealthSnapshot;
  }

  getBlock(height: number): BlockInfo | null {
    const record = this.blocks.get(String(height));
    if (!record) {
      return null;
    }
    return {
      height: record.height,
      hash: record.hash,
      parentHash: record.parentHash,
      timestamp: record.timestamp,
    } as BlockInfo;
  }

  getReorgHistory(): ReorgEvent[] {
    return this.reorgHistory.map((event) => ({ ...event }));
  }
}
