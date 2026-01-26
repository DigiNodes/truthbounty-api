import { Injectable, Logger } from '@nestjs/common';
import { BlockchainStateService } from './state.service';
import { BlockInfo, ReorgEvent, PendingEvent } from './types';

/**
 * Detects and handles chain reorganizations
 */
@Injectable()
export class ReorgDetectorService {
  private readonly logger = new Logger(ReorgDetectorService.name);
  private readonly CONFIRMATION_DEPTH = 12; // ~3 minutes for Ethereum (~12 sec blocks)

  constructor(private stateService: BlockchainStateService) {}

  /**
   * Check if a reorg has occurred by comparing block hashes
   * Returns detected reorg information or null if no reorg
   */
  async detectReorg(
    currentBlock: BlockInfo,
    previousBlockNumber: number,
  ): Promise<ReorgEvent | null> {
    if (previousBlockNumber === 0) {
      return null; // First block, no reorg possible
    }

    // Get the expected parent block hash from our records
    const expectedParent = await this.stateService.getCanonicalBlock(
      previousBlockNumber,
    );

    if (!expectedParent) {
      // We don't have records of this block yet, can't detect reorg
      return null;
    }

    // Check if the block hash matches our records
    if (expectedParent.blockHash === currentBlock.parentHash) {
      // Chain is canonical, no reorg
      return null;
    }

    // Reorg detected! The parent hash doesn't match our records
    this.logger.warn(
      `Reorg detected! Current parent hash: ${currentBlock.parentHash}, ` +
      `expected: ${expectedParent.blockHash}`,
    );

    // Find the divergence point
    const reorgDepth = await this.findDivergencePoint(currentBlock);
    const affectedBlockStart = previousBlockNumber - reorgDepth + 1;
    const affectedBlockEnd = previousBlockNumber;

    // Get all affected events
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

    return reorg;
  }

  /**
   * Find the exact divergence point in the chain
   */
  private async findDivergencePoint(currentBlock: BlockInfo): Promise<number> {
    let divergenceDepth = 1;
    let checkBlockNumber = currentBlock.number - 1;

    // Walk backwards through the chain to find where it diverges
    while (checkBlockNumber > 0 && divergenceDepth <= 1000) {
      const canonicalBlock = await this.stateService.getCanonicalBlock(
        checkBlockNumber,
      );

      if (canonicalBlock && canonicalBlock.blockHash !== currentBlock.parentHash) {
        // Keep checking
        divergenceDepth++;
        checkBlockNumber--;
      } else {
        // Found the point where chains match
        break;
      }
    }

    return divergenceDepth;
  }

  /**
   * Get all events affected by reorg
   */
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
   * Calculate confirmation count for an event
   */
  async calculateConfirmations(blockNumber: number, headBlockNumber: number): Promise<number> {
    return Math.max(0, headBlockNumber - blockNumber);
  }

  /**
   * Check if an event is sufficiently confirmed
   */
  async isEventConfirmed(blockNumber: number, headBlockNumber: number): Promise<boolean> {
    const confirmations = await this.calculateConfirmations(blockNumber, headBlockNumber);
    return confirmations >= this.CONFIRMATION_DEPTH;
  }

  /**
   * Get the confirmation depth requirement
   */
  getConfirmationDepth(): number {
    return this.CONFIRMATION_DEPTH;
  }

  /**
   * Set custom confirmation depth (for testing)
   */
  setConfirmationDepth(depth: number): void {
    if (depth < 1) {
      throw new Error('Confirmation depth must be at least 1');
    }
    // In a real implementation, this would be configurable
    // For now, we use the hardcoded value
  }
}
