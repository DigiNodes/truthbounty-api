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
    observedHeadBlock: 0,
    safeBlock: 0,
    finalizedBlock: 0,
    projectionHeadBlock: 0,
    rpcFailureCount: 0,
    replayCount: 0,
    deadLetterCount: 0,
    lastRpcErrorAt: null,
    projectionLag: 0,
  };

  private readonly maxBlocksInMemory: number;
  private readonly maxEventsInMemory: number;
  private readonly maxReorgHistoryEntries: number;

  // Alert thresholds (configurable, with safe defaults).
  private readonly projectionLagThresholdBlocks: number;
  private readonly rpcFailureWindow: number;
  private readonly rpcFailureLimit: number;
  private readonly maxDeadLetters: number;
  private readonly rpcFailureTimestamps: number[] = [];
  private readonly runbookUrl: string;

  constructor(@Optional() private configService?: ConfigService) {
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

    this.projectionLagThresholdBlocks =
      this.configService?.get<number>(
        'blockchain.projectionLagThresholdBlocks',
        150,
      ) ?? 150;
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

    this.logger.log(
      `Memory limits — blocks: ${this.maxBlocksInMemory}, ` +
        `events: ${this.maxEventsInMemory}, ` +
        `reorg history: ${this.maxReorgHistoryEntries}, ` +
        `projection lag threshold: ${this.projectionLagThresholdBlocks} blocks`,
    );
  }

  async saveBlock(block: BlockInfo): Promise<BlockRecord> {
    const blockRecord: BlockRecord = {
      id: `${block.number}:${block.hash}`,
      blockNumber: block.number,
      blockHash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      isCanonical: true,
      createdAt: new Date(),
    };

    this.blocks.set(blockRecord.id, blockRecord);
    this.evictOldBlocks();
    return blockRecord;
  }

  async getBlock(
    blockNumber: number,
    blockHash: string,
  ): Promise<BlockRecord | null> {
    const record = this.blocks.get(`${blockNumber}:${blockHash}`);
    return record || null;
  }

  async getBlocksAtHeight(blockNumber: number): Promise<BlockRecord[]> {
    const result: BlockRecord[] = [];
    this.blocks.forEach((block) => {
      if (block.blockNumber === blockNumber) {
        result.push(block);
      }
    });
    return result;
  }

  async getCanonicalBlock(blockNumber: number): Promise<BlockRecord | null> {
    const blocks = await this.getBlocksAtHeight(blockNumber);
    return blocks.find((b) => b.isCanonical) || null;
  }

  async getCanonicalBlockByHash(
    blockHash: string,
  ): Promise<BlockRecord | null> {
    for (const [, block] of this.blocks) {
      if (block.blockHash === blockHash && block.isCanonical) {
        return block;
      }
    }
    return null;
  }

  async savePendingEvent(event: PendingEvent): Promise<void> {
    this.events.set(event.id, event);
    if (event.status === 'pending') {
      this.chainState.pendingEventCount++;
    }
    this.evictOldEvents();
  }

  async getEvent(eventId: string): Promise<PendingEvent | null> {
    return this.events.get(eventId) || null;
  }

  async getEventsByBlock(blockNumber: number): Promise<PendingEvent[]> {
    const blockEvents: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.blockNumber === blockNumber) {
        blockEvents.push(event);
      }
    });
    return blockEvents;
  }

  async getPendingEvents(): Promise<PendingEvent[]> {
    const pending: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.status === 'pending') {
        pending.push(event);
      }
    });
    return pending;
  }

  async getOrphanedEvents(): Promise<PendingEvent[]> {
    const orphaned: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.status === 'orphaned') {
        orphaned.push(event);
      }
    });
    return orphaned;
  }

  async updateEventStatus(
    eventId: string,
    status: 'pending' | 'confirmed' | 'orphaned',
    confirmations?: number,
  ): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    const oldStatus = event.status;
    event.status = status;
    event.confirmations = confirmations ?? event.confirmations;

    if (status === 'confirmed') {
      event.confirmedAt = new Date();
      if (oldStatus === 'pending') {
        this.chainState.pendingEventCount--;
      }
    } else if (status === 'orphaned') {
      if (oldStatus === 'pending') {
        this.chainState.pendingEventCount--;
      }
      this.chainState.orphanedEventCount++;
    }
  }

  async markBlocksNonCanonical(blockNumbers: number[]): Promise<void> {
    this.blocks.forEach((block) => {
      if (blockNumbers.includes(block.blockNumber)) {
        block.isCanonical = false;
      }
    });
  }

  async recordReorg(reorg: ReorgEvent): Promise<void> {
    this.reorgHistory.push(reorg);
    this.chainState.lastReorgTime = reorg.detectedAt;
    this.trimReorgHistory();
  }

  async getReorgHistory(): Promise<ReorgEvent[]> {
    return this.reorgHistory;
  }

  async updateChainState(partial: Partial<ChainState>): Promise<void> {
    this.chainState = { ...this.chainState, ...partial };
  }

  async getChainState(): Promise<ChainState> {
    return { ...this.chainState };
  }

  /**
   * Record the highest block observed from the RPC provider (the observed head).
   * Updates the derived projection lag against the finalized cursor.
   */
  async setObservedHead(blockNumber: number): Promise<void> {
    this.chainState.observedHeadBlock = blockNumber;
    this.refreshProjectionLag();
  }

  /**
   * Record the chain's safe cursor (reorg-unlikely boundary).
   */
  async setSafeBlock(blockNumber: number): Promise<void> {
    this.chainState.safeBlock = blockNumber;
  }

  /**
   * Record the chain's finalized cursor (finality boundary).
   * Recomputes projection lag against the observed head.
   */
  async setFinalizedBlock(blockNumber: number): Promise<void> {
    this.chainState.finalizedBlock = blockNumber;
    this.refreshProjectionLag();
  }

  /**
   * Record the highest block to which projections (derived, rebuildable state)
   * have advanced.
   */
  async setProjectionHead(blockNumber: number): Promise<void> {
    this.chainState.projectionHeadBlock = blockNumber;
  }

  /**
   * Record a single RPC failure. Failure rate is evaluated over a sliding window
   * (default 5 minutes). The monotonic counter is preserved for Prometheus.
   */
  async recordRpcFailure(error?: Error | string): Promise<void> {
    const now = Date.now();
    this.chainState.rpcFailureCount =
      (this.chainState.rpcFailureCount ?? 0) + 1;
    this.chainState.lastRpcErrorAt = new Date(now).toISOString();
    this.rpcFailureTimestamps.push(now);

    // Keep only failures within the sliding window.
    while (
      this.rpcFailureTimestamps.length > 0 &&
      this.rpcFailureTimestamps[0] < now - this.rpcFailureWindow
    ) {
      this.rpcFailureTimestamps.shift();
    }

    const message =
      error instanceof Error ? error.message : String(error ?? '');
    this.logger.warn(
      `RPC failure recorded (total=${this.chainState.rpcFailureCount}, ` +
        `window=${this.rpcFailureTimestamps.length}${message ? `): ${message}` : ')'}`,
    );
  }

  /**
   * Record an event replay (reprocessed after a reorg or retry).
   */
  async recordReplay(count = 1): Promise<void> {
    this.chainState.replayCount = (this.chainState.replayCount ?? 0) + count;
  }

  /**
   * Record a dead-lettered event (one that failed past max retries).
   */
  async recordDeadLetter(count = 1): Promise<void> {
    this.chainState.deadLetterCount =
      (this.chainState.deadLetterCount ?? 0) + count;
  }

  /**
   * Number of RPC failures within the configured sliding window.
   */
  getRpcFailuresInWindow(): number {
    const now = Date.now();
    return this.rpcFailureTimestamps.filter(
      (t) => t >= now - this.rpcFailureWindow,
    ).length;
  }

  /**
   * Projection lag in blocks, computed from the finalized cursor to the observed head.
   * Returns 0 when no head has been observed yet.
   */
  getProjectionLag(): number {
    const lag =
      (this.chainState.observedHeadBlock ?? 0) -
      (this.chainState.finalizedBlock ?? 0);
    return lag > 0 ? lag : 0;
  }

  /**
   * Derive the sanitized indexer health snapshot for health/metrics consumers.
   * Fails closed on incompatible state (missing cursors => unhealthy).
   */
  async getIndexerHealth(): Promise<IndexerHealthSnapshot> {
    const projectionLag = this.getProjectionLag();
    const rpcFailuresInWindow = this.getRpcFailuresInWindow();

    let status: IndexerHealthStatus = 'healthy';
    if (
      projectionLag > this.projectionLagThresholdBlocks ||
      rpcFailuresInWindow >= this.rpcFailureLimit ||
      (this.chainState.deadLetterCount ?? 0) > this.maxDeadLetters
    ) {
      status = 'degraded';
    }
    if (
      this.chainState.observedHeadBlock == null ||
      this.chainState.finalizedBlock == null ||
      this.chainState.rpcFailureCount == null
    ) {
      status = 'unhealthy';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      observedHeadBlock: this.chainState.observedHeadBlock ?? 0,
      safeBlock: this.chainState.safeBlock ?? 0,
      finalizedBlock: this.chainState.finalizedBlock ?? 0,
      projectionHeadBlock: this.chainState.projectionHeadBlock ?? 0,
      projectionLag,
      rpcFailureCount: this.chainState.rpcFailureCount ?? 0,
      replayCount: this.chainState.replayCount ?? 0,
      deadLetterCount: this.chainState.deadLetterCount ?? 0,
      alertThresholds: {
        projectionLagBlocks: this.projectionLagThresholdBlocks,
        rpcFailureRateWindow: this.rpcFailureWindow,
        maxDeadLetters: this.maxDeadLetters,
      },
      runbookUrl: this.runbookUrl,
    };
  }

  private refreshProjectionLag(): void {
    this.chainState.projectionLag = this.getProjectionLag();
  }

  async deleteEvents(eventIds: string[]): Promise<void> {
    for (const id of eventIds) {
      const event = this.events.get(id);
      if (event) {
        if (event.status === 'pending') {
          this.chainState.pendingEventCount--;
        } else if (event.status === 'orphaned') {
          this.chainState.orphanedEventCount--;
        }
        this.events.delete(id);
      }
    }
  }

  async clearAllState(): Promise<void> {
    this.blocks.clear();
    this.events.clear();
    this.reorgHistory = [];
    this.rpcFailureTimestamps.length = 0;
    this.chainState = {
      lastProcessedBlock: 0,
      lastCanonicalHash: '',
      confirmedDepth: 0,
      pendingEventCount: 0,
      orphanedEventCount: 0,
      observedHeadBlock: 0,
      safeBlock: 0,
      finalizedBlock: 0,
      projectionHeadBlock: 0,
      rpcFailureCount: 0,
      replayCount: 0,
      deadLetterCount: 0,
      lastRpcErrorAt: null,
      projectionLag: 0,
    };
  }

  async getMemoryStats(): Promise<StateMemoryStats> {
    let confirmed = 0;
    let pending = 0;
    let orphaned = 0;
    this.events.forEach((event) => {
      if (event.status === 'confirmed') confirmed++;
      else if (event.status === 'pending') pending++;
      else if (event.status === 'orphaned') orphaned++;
    });

    return {
      currentBlockCount: this.blocks.size,
      currentEventCount: this.events.size,
      currentReorgHistoryCount: this.reorgHistory.length,
      maxBlocksInMemory: this.maxBlocksInMemory,
      maxEventsInMemory: this.maxEventsInMemory,
      maxReorgHistoryEntries: this.maxReorgHistoryEntries,
      confirmedEventCount: confirmed,
      pendingEventCount: pending,
      orphanedEventCount: orphaned,
    };
  }

  private evictOldBlocks(): void {
    if (this.blocks.size <= this.maxBlocksInMemory) return;

    const sorted: { id: string; blockNumber: number }[] = [];
    this.blocks.forEach((block, id) => {
      sorted.push({ id, blockNumber: block.blockNumber });
    });

    sorted.sort((a, b) => a.blockNumber - b.blockNumber);

    const excess = this.blocks.size - this.maxBlocksInMemory;
    for (let i = 0; i < excess; i++) {
      this.blocks.delete(sorted[i].id);
    }

    this.logger.debug(`Evicted ${excess} old block(s) from memory`);
  }

  private evictOldEvents(): void {
    if (this.events.size <= this.maxEventsInMemory) return;

    const confirmed: { id: string; confirmedAt?: Date }[] = [];
    this.events.forEach((event, id) => {
      if (event.status === 'confirmed') {
        confirmed.push({ id, confirmedAt: event.confirmedAt });
      }
    });

    confirmed.sort((a, b) => {
      if (!a.confirmedAt && !b.confirmedAt) return 0;
      if (!a.confirmedAt) return -1;
      if (!b.confirmedAt) return 1;
      return a.confirmedAt.getTime() - b.confirmedAt.getTime();
    });

    const excess = this.events.size - this.maxEventsInMemory;
    const toRemove = Math.min(excess, confirmed.length);
    for (let i = 0; i < toRemove; i++) {
      this.events.delete(confirmed[i].id);
    }

    if (toRemove > 0) {
      this.logger.debug(
        `Evicted ${toRemove} old confirmed event(s) from memory`,
      );
    }
  }

  private trimReorgHistory(): void {
    while (this.reorgHistory.length > this.maxReorgHistoryEntries) {
      this.reorgHistory.shift();
    }
  }
}
