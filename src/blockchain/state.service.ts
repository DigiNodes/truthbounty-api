import { Injectable } from '@nestjs/common';
import {
  BlockRecord,
  PendingEvent,
  ReorgEvent,
  ChainState,
  BlockInfo,
} from './types';

/**
 * In-memory state management for blockchain tracking
 * In production, this would be backed by a persistent database (PostgreSQL, MongoDB, etc.)
 */
@Injectable()
export class BlockchainStateService {
  // In-memory storage (replace with database in production)
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

  /**
   * Store a block record
   */
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
    return blockRecord;
  }

  /**
   * Get block by number and hash
   */
  async getBlock(blockNumber: number, blockHash: string): Promise<BlockRecord | null> {
    const record = this.blocks.get(`${blockNumber}:${blockHash}`);
    return record || null;
  }

  /**
   * Get all blocks at a specific block number
   */
  async getBlocksAtHeight(blockNumber: number): Promise<BlockRecord[]> {
    const blocks: BlockRecord[] = [];
    this.blocks.forEach((block) => {
      if (block.blockNumber === blockNumber) {
        blocks.push(block);
      }
    });
    return blocks;
  }

  /**
   * Get the canonical block at a height
   */
  async getCanonicalBlock(blockNumber: number): Promise<BlockRecord | null> {
    const blocks = await this.getBlocksAtHeight(blockNumber);
    return blocks.find((b) => b.isCanonical) || null;
  }

  /**
   * Store a pending event
   */
  async savePendingEvent(event: PendingEvent): Promise<void> {
    this.events.set(event.id, event);
    if (event.status === 'pending') {
      this.chainState.pendingEventCount++;
    }
  }

  /**
   * Get event by ID
   */
  async getEvent(eventId: string): Promise<PendingEvent | null> {
    return this.events.get(eventId) || null;
  }

  /**
   * Get all events at a specific block
   */
  async getEventsByBlock(blockNumber: number): Promise<PendingEvent[]> {
    const blockEvents: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.blockNumber === blockNumber) {
        blockEvents.push(event);
      }
    });
    return blockEvents;
  }

  /**
   * Get all pending events
   */
  async getPendingEvents(): Promise<PendingEvent[]> {
    const pending: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.status === 'pending') {
        pending.push(event);
      }
    });
    return pending;
  }

  /**
   * Get all orphaned events
   */
  async getOrphanedEvents(): Promise<PendingEvent[]> {
    const orphaned: PendingEvent[] = [];
    this.events.forEach((event) => {
      if (event.status === 'orphaned') {
        orphaned.push(event);
      }
    });
    return orphaned;
  }

  /**
   * Update event status
   */
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

  /**
   * Mark blocks as non-canonical (used during reorg detection)
   */
  async markBlocksNonCanonical(blockNumbers: number[]): Promise<void> {
    this.blocks.forEach((block) => {
      if (blockNumbers.includes(block.blockNumber)) {
        block.isCanonical = false;
      }
    });
  }

  /**
   * Record a reorg event
   */
  async recordReorg(reorg: ReorgEvent): Promise<void> {
    this.reorgHistory.push(reorg);
    this.chainState.lastReorgTime = reorg.detectedAt;
  }

  /**
   * Get reorg history
   */
  async getReorgHistory(): Promise<ReorgEvent[]> {
    return this.reorgHistory;
  }

  /**
   * Update chain state
   */
  async updateChainState(partial: Partial<ChainState>): Promise<void> {
    this.chainState = { ...this.chainState, ...partial };
  }

  /**
   * Get current chain state
   */
  async getChainState(): Promise<ChainState> {
    return { ...this.chainState };
  }

  /**
   * Delete events (used during reorg rollback)
   */
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

  /**
   * Clear all state (useful for testing)
   */
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
}
