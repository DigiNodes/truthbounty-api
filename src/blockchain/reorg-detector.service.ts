import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainStateService } from './state.service';
import { BlockInfo, ReorgEvent, PendingEvent } from './types';

/**
 * Detects and handles chain reorganizations
 */
@Injectable()
export class ReorgDetectorService {
  private readonly logger = new Logger(ReorgDetectorService.name);

  /**
   * Mutable confirmation depth, seeded from config.
   * Default: 12 (~3 minutes for Ethereum at ~12 sec blocks).
   */
  private confirmationDepth: number;

  constructor(
    private stateService: BlockchainStateService,
    private configService: ConfigService,
  ) {
    this.confirmationDepth = this.configService.get<number>(
      'BLOCKCHAIN_CONFIRMATION_DEPTH',
      12,
    );

    this.logger.log(`Confirmation depth set to ${this.confirmationDepth}`);
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

    const expectedParent = await this.stateService.getCanonicalBlock(
      previousBlockNumber,
    );

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
      const canonicalBlock = await this.stateService.getCanonicalBlock(
        checkBlockNumber,
      );

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
        expectedHash = await this.getAncestorHashAtDepth(currentBlock, divergenceDepth);
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
  private async getAncestorHashAtDepth(currentBlock: BlockInfo, depth: number): Promise<string> {
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