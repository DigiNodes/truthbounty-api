import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainStateService } from './state.service';
import { ClaimsCache } from '../cache/claims.cache';
import { BlockInfo, ReorgEvent, PendingEvent } from './types';

/**
 * Detects and handles chain reorganizations
 */ @Injectable()
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

  constructor(
    private stateService: BlockchainStateService,
    private configService: ConfigService,
    private claimsCache: ClaimsCache,
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
    if (configMaxReorgDepth > FINALITY_MAX_SANE_DEPTH) {
      throw new Error(
        `FINALITY_MAX_REORG_DEPTH exceeds the sane upper bound of ${FINALITY_MAX_SANE_DEPTH} (got ${configMaxReorgDepth})`,
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
    if (configAncestorSearchBudget > FINALITY_MAX_SANE_DEPTH) {
      throw new Error(
        `FINALITY_MAX_ANCESTOR_SEARCH exceeds the sane upper bound of ${FINALITY_MAX_SANE_DEPTH} (got ${configAncestorSearchBudget})`,
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
   *
   * Both the resulting reorg depth and the internal ancestor hash walk are
   * bounded. A depth that even approaches the hard ceiling is treated as an
   * unrecoverable state: the detector halts readiness with operator guidance
   * instead of silently searching unboundedly or exposing a fabricated depth.
   */
  private async findDivergencePoint(currentBlock: BlockInfo): Promise<number> {
    let divergenceDepth = 0;
    let checkBlockNumber = currentBlock.number;
    // The flat sane depth is the absolute ceiling for chain-derived depth. It
    // covers confirmations, reorg depth, and the bounded ancestor walk, so a
    // fat-fingered env value cannot start an unbounded walk.
    if (checkBlockNumber > ReorgDetectorService.FINALITY_MAX_SANE_DEPTH) {
      throw new Error(
        `Current block ${checkBlockNumber} exceeds the bounded search ceiling of ${ReorgDetectorService.FINALITY_MAX_SANE_DEPTH}; refusing to walk the chain. Halt readiness and contact the operator.`,
      );
    }

    // Walk backwards through the chain to find where it diverges
    // We compare the expected hash in our current chain at each depth
    // with the canonical block at that height
    while (checkBlockNumber > 0 && divergenceDepth <= this.maxReorgDepth) {
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
          // For depth > 0, we need to get the ancestor at this depth.
          // The walk is capped here so a mismatched/rigged chain cannot
          // generate unbounded ancestor lookups.
          if (divergenceDepth > this.maxAncestorSearch) {
            throw new Error(
              `Reorg ancestor search exceeded the bounded budget of ${this.maxAncestorSearch} hops while searching for divergence at block ${checkBlockNumber}. Halt readiness and contact the operator.`,
            );
          }
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
