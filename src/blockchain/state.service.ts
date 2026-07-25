import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlockRecord,
  PendingEvent,
  ReorgEvent,
  ChainState,
  BlockInfo,
  StateMemoryStats,
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
  };

  private readonly maxBlocksInMemory: number;
  private readonly maxEventsInMemory: number;
  private readonly maxReorgHistoryEntries: number;

  constructor(
    @Optional() private configService?: ConfigService,
  ) {
    this.maxBlocksInMemory = this.configService?.get<number>(
      'blockchain.maxBlocksInMemory', 10000,
    ) ?? 10000;
    this.maxEventsInMemory = this.configService?.get<number>(
      'blockchain.maxEventsInMemory', 50000,
    ) ?? 50000;
    this.maxReorgHistoryEntries = this.configService?.get<number>(
      'blockchain.maxReorgHistoryEntries', 1000,
    ) ?? 1000;

    this.logger.log(
      `Memory limits — blocks: ${this.maxBlocksInMemory}, ` +
      `events: ${this.maxEventsInMemory}, ` +
      `reorg history: ${this.maxReorgHistoryEntries}`,
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

  async getBlock(blockNumber: number, blockHash: string): Promise<BlockRecord | null> {
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

  async getCanonicalBlockByHash(blockHash: string): Promise<BlockRecord | null> {
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
    this.chainState = {
      lastProcessedBlock: 0,
      lastCanonicalHash: '',
      confirmedDepth: 0,
      pendingEventCount: 0,
      orphanedEventCount: 0,
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
      this.logger.debug(`Evicted ${toRemove} old confirmed event(s) from memory`);
    }
  }

  private trimReorgHistory(): void {
    while (this.reorgHistory.length > this.maxReorgHistoryEntries) {
      this.reorgHistory.shift();
    }
  }
}
