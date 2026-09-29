import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BlockHeader,
  CommonAncestorResult,
  ConfirmationLevel,
  CursorState,
} from './block-cursor.types';

/**
 * How many recent block headers to retain per cursor for common-ancestor
 * recovery. A reorg cannot reach below the finalized boundary, so ancestry
 * entries older than this window (and at/below the finalized height) are
 * pruned; keeping them indefinitely would grow this table unboundedly.
 */
const ANCESTRY_WINDOW = 512n;

/**
 * Persists a reorg-aware block cursor: the highest processed (height, hash),
 * finality-lagged safe/finalized cursors, and a rolling ancestry window
 * (height, hash, parentHash) used to find the common ancestor after a reorg.
 *
 * This is an indexing/read boundary only. It records what the indexer has
 * observed about chain shape; it never computes or mutates settlement,
 * reward, treasury, or governance state. Optimism/EVM semantics only.
 */
@Injectable()
export class BlockCursorService {
  private readonly logger = new Logger(BlockCursorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCursor(chainId: number, source: string): Promise<CursorState | null> {
    const row = await this.prisma.blockCursor.findUnique({
      where: { chainId_source: { chainId, source } },
    });
    if (!row) return null;
    return {
      chainId: row.chainId,
      source: row.source,
      processedHeight: row.processedHeight,
      processedHash: row.processedHash,
      safeHeight: row.safeHeight,
      safeHash: row.safeHash,
      finalizedHeight: row.finalizedHeight,
      finalizedHash: row.finalizedHash,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Record a newly-processed block on the (assumed) canonical chain: advances
   * the processed cursor and appends it to the ancestry window. Not
   * reorg-aware by itself — callers that suspect a reorg should call
   * `findCommonAncestor` first and reconcile via `recoverToAncestor` before
   * recording forward again.
   */
  async recordBlock(
    chainId: number,
    source: string,
    header: BlockHeader,
    confirmation: ConfirmationLevel = 'observed',
  ): Promise<void> {
    const blockHash = header.hash.toLowerCase();
    const parentHash = header.parentHash.toLowerCase();

    await this.prisma.$transaction(async (tx) => {
      const cursor = await tx.blockCursor.upsert({
        where: { chainId_source: { chainId, source } },
        update: {
          processedHeight: header.height,
          processedHash: blockHash,
        },
        create: {
          chainId,
          source,
          processedHeight: header.height,
          processedHash: blockHash,
        },
      });

      await tx.blockCursorAncestor.upsert({
        where: {
          cursorId_height_hash: {
            cursorId: cursor.id,
            height: header.height,
            hash: blockHash,
          },
        },
        update: { parentHash, confirmation, isCanonical: true },
        create: {
          cursorId: cursor.id,
          height: header.height,
          hash: blockHash,
          parentHash,
          confirmation,
        },
      });

      const pruneBelow = header.height - ANCESTRY_WINDOW;
      if (pruneBelow > 0n) {
        await tx.blockCursorAncestor.deleteMany({
          where: { cursorId: cursor.id, height: { lt: pruneBelow } },
        });
      }
    });
  }

  /** Advance the finality-lagged safe/finalized cursors and mark matching ancestry entries. */
  async updateConfirmations(
    chainId: number,
    source: string,
    safe?: BlockHeader,
    finalized?: BlockHeader,
  ): Promise<void> {
    const cursor = await this.prisma.blockCursor.findUnique({
      where: { chainId_source: { chainId, source } },
    });
    if (!cursor) {
      throw new Error(
        `No block cursor for chain=${chainId} source=${source}; call recordBlock first`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.blockCursor.update({
        where: { id: cursor.id },
        data: {
          ...(safe && { safeHeight: safe.height, safeHash: safe.hash.toLowerCase() }),
          ...(finalized && {
            finalizedHeight: finalized.height,
            finalizedHash: finalized.hash.toLowerCase(),
          }),
        },
      });

      if (finalized) {
        await tx.blockCursorAncestor.updateMany({
          where: { cursorId: cursor.id, height: { lte: finalized.height }, isCanonical: true },
          data: { confirmation: 'finalized' },
        });
      } else if (safe) {
        await tx.blockCursorAncestor.updateMany({
          where: {
            cursorId: cursor.id,
            height: { lte: safe.height },
            isCanonical: true,
            confirmation: 'observed',
          },
          data: { confirmation: 'safe' },
        });
      }
    });
  }

  /**
   * Walk stored ancestry newest-to-oldest, comparing each stored (height,
   * hash) against the caller-supplied `candidates` (the chain's current
   * canonical view for the same heights, freshly fetched from RPC). The
   * first match is the common ancestor; everything stored above it has been
   * orphaned by the reorg.
   */
  async findCommonAncestor(
    chainId: number,
    source: string,
    candidates: BlockHeader[],
  ): Promise<CommonAncestorResult> {
    const cursor = await this.prisma.blockCursor.findUnique({
      where: { chainId_source: { chainId, source } },
    });
    if (!cursor) return { found: false };

    const candidateByHeight = new Map(
      candidates.map((c) => [c.height.toString(), c.hash.toLowerCase()]),
    );

    const stored = await this.prisma.blockCursorAncestor.findMany({
      where: { cursorId: cursor.id, isCanonical: true },
      orderBy: { height: 'desc' },
    });

    const orphanedHeights: bigint[] = [];
    for (const entry of stored) {
      const candidateHash = candidateByHeight.get(entry.height.toString());
      if (candidateHash && candidateHash === entry.hash) {
        return {
          found: true,
          ancestor: { height: entry.height, hash: entry.hash, parentHash: entry.parentHash },
          orphanedHeights,
        };
      }
      orphanedHeights.push(entry.height);
    }

    return { found: false };
  }

  /**
   * Reconcile after a reorg: mark ancestry strictly above the common
   * ancestor as orphaned (kept for audit, not deleted) and rewind the
   * processed cursor to the ancestor so the indexer resumes re-ingestion
   * from a known-canonical point.
   */
  async recoverToAncestor(
    chainId: number,
    source: string,
    ancestor: BlockHeader,
  ): Promise<void> {
    const cursor = await this.prisma.blockCursor.findUnique({
      where: { chainId_source: { chainId, source } },
    });
    if (!cursor) {
      throw new Error(
        `No block cursor for chain=${chainId} source=${source}; nothing to recover`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.blockCursorAncestor.updateMany({
        where: { cursorId: cursor.id, height: { gt: ancestor.height }, isCanonical: true },
        data: { isCanonical: false },
      });

      await tx.blockCursor.update({
        where: { id: cursor.id },
        data: {
          processedHeight: ancestor.height,
          processedHash: ancestor.hash.toLowerCase(),
        },
      });
    });

    this.logger.warn(
      `Reorg recovery: chain=${chainId} source=${source} rewound to height=${ancestor.height} hash=${ancestor.hash}`,
    );
  }
}
