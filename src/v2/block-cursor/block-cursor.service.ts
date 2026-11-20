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
 * Durable, database-authoritative reorg-aware block cursor. This is the single
 * canonical cursor/reorg state boundary for active production indexers, keyed
 * by (chainId, source, releaseId, projectionId). All mutations are performed
 * inside transactions guarded by a compare-and-swap on `version`, so concurrent
 * processes and replicas cannot skip or conflict cursor writes.
 *
 * Indexing/read boundary only: never computes settlement, reward, treasury, or
 * governance state. Optimism/EVM semantics only.
 */
@Injectable()
export class BlockCursorService {
  private readonly logger = new Logger(BlockCursorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCursor(
    chainId: number,
    source: string,
    releaseId: string,
    projectionId: string,
  ): Promise<CursorState | null> {
    const row = await this.prisma.blockCursor.findUnique({
      where: {
        chainId_source_releaseId_projectionId: {
          chainId,
          source,
          releaseId,
          projectionId,
        },
      },
    });
    if (!row) return null;
    return {
      chainId: row.chainId,
      source: row.source,
      releaseId: row.releaseId,
      projectionId: row.projectionId,
      deploymentBlock: row.deploymentBlock,
      artifactChecksum: row.artifactChecksum,
      processedHeight: row.processedHeight,
      processedHash: row.processedHash,
      safeHeight: row.safeHeight,
      safeHash: row.safeHash,
      finalizedHeight: row.finalizedHeight,
      finalizedHash: row.finalizedHash,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Record a newly-processed block on the canonical chain using a durable CAS:
   * the update only succeeds if the cursor's `version` still equals the value
   * the caller read. Stale writers receive an error instead of silently
   * overwriting progress.
   */
  async recordBlock(
    chainId: number,
    source: string,
    releaseId: string,
    projectionId: string,
    expectedVersion: number,
    header: BlockHeader,
    confirmation: ConfirmationLevel = 'observed',
  ): Promise<void> {
    const blockHash = header.hash.toLowerCase();
    const parentHash = header.parentHash.toLowerCase();

    await this.prisma.$transaction(async (tx) => {
      const cursor = await tx.blockCursor.findUnique({
        where: {
          chainId_source_releaseId_projectionId: {
            chainId,
            source,
            releaseId,
            projectionId,
          },
        },
      });
      if (!cursor) {
        throw new Error(
          `No block cursor for chain=${chainId} source=${source} release=${releaseId} projection=${projectionId}`,
        );
      }
      if (cursor.version !== expectedVersion) {
        throw new Error(
          `Block cursor CAS conflict: expected version=${expectedVersion} actual=${cursor.version}`,
        );
      }
      if (header.height <= cursor.processedHeight) {
        throw new Error(
          `Refusing non-forward cursor write: height=${header.height} processed=${cursor.processedHeight}`,
        );
      }

      const updated = await tx.blockCursor.updateMany({
        where: { id: cursor.id, version: expectedVersion },
        data: {
          processedHeight: header.height,
          processedHash: blockHash,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error('Block cursor CAS conflict on advance');
      }

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

  /** Advance finality-lagged safe/finalized cursors under CAS and mark ancestry. */
  async updateConfirmations(
    chainId: number,
    source: string,
    releaseId: string,
    projectionId: string,
    expectedVersion: number,
    safe?: BlockHeader,
    finalized?: BlockHeader,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cursor = await tx.blockCursor.findUnique({
        where: {
          chainId_source_releaseId_projectionId: {
            chainId,
            source,
            releaseId,
            projectionId,
          },
        },
      });
      if (!cursor) {
        throw new Error(
          `No block cursor for chain=${chainId} source=${source}; call recordBlock first`,
        );
      }
      if (cursor.version !== expectedVersion) {
        throw new Error(
          `Block cursor CAS conflict: expected version=${expectedVersion} actual=${cursor.version}`,
        );
      }
      if (finalized && cursor.finalizedHeight > finalized.height) {
        throw new Error('Finalized cursor cannot move backward');
      }
      if (safe && cursor.safeHeight > safe.height) {
        throw new Error('Safe cursor cannot move backward');
      }

      const updated = await tx.blockCursor.updateMany({
        where: { id: cursor.id, version: expectedVersion },
        data: {
          ...(safe && {
            safeHeight: safe.height,
            safeHash: safe.hash.toLowerCase(),
          }),
          ...(finalized && {
            finalizedHeight: finalized.height,
            finalizedHash: finalized.hash.toLowerCase(),
          }),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error('Block cursor CAS conflict on confirmation update');
      }

      if (finalized) {
        await tx.blockCursorAncestor.updateMany({
          where: {
            cursorId: cursor.id,
            height: { lte: finalized.height },
            isCanonical: true,
          },
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
   * Walk stored ancestry newest-to-oldest against the chain's current canonical
   * view. Returns found=false when no match exists within the retained window,
   * which callers must treat as a fail-closed deep reorg.
   */
  async findCommonAncestor(
    chainId: number,
    source: string,
    releaseId: string,
    projectionId: string,
    candidates: BlockHeader[],
  ): Promise<CommonAncestorResult> {
    const cursor = await this.prisma.blockCursor.findUnique({
      where: {
        chainId_source_releaseId_projectionId: {
          chainId,
          source,
          releaseId,
          projectionId,
        },
      },
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
          ancestor: {
            height: entry.height,
            hash: entry.hash,
            parentHash: entry.parentHash,
          },
          orphanedHeights,
        };
      }
      orphanedHeights.push(entry.height);
    }

    return { found: false };
  }

  /**
   * Reconcile after a reorg under CAS. Rollback is only permitted with explicit
   * operator authorization, a reason, and an authorization reference that is
   * unique (a stale authorization cannot be replayed). Finalized state cannot
   * be rolled back. Orphaned ancestry is retained for audit.
   */
  async recoverToAncestor(
    chainId: number,
    source: string,
    releaseId: string,
    projectionId: string,
    expectedVersion: number,
    ancestor: BlockHeader,
    authorization: {
      authorizedBy: string;
      authorizationRef: string;
      reason: string;
      auditData?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (
      !authorization.authorizedBy ||
      !authorization.authorizationRef ||
      !authorization.reason
    ) {
      throw new Error('Rollback requires authorizedBy, authorizationRef and reason');
    }

    await this.prisma.$transaction(async (tx) => {
      const cursor = await tx.blockCursor.findUnique({
        where: {
          chainId_source_releaseId_projectionId: {
            chainId,
            source,
            releaseId,
            projectionId,
          },
        },
      });
      if (!cursor) {
        throw new Error(
          `No block cursor for chain=${chainId} source=${source}; nothing to recover`,
        );
      }
      if (cursor.version !== expectedVersion) {
        throw new Error(
          `Block cursor CAS conflict: expected version=${expectedVersion} actual=${cursor.version}`,
        );
      }
      if (ancestor.height < cursor.finalizedHeight) {
        throw new Error('Rollback below finalized boundary is forbidden');
      }
      if (ancestor.height < cursor.deploymentBlock) {
        throw new Error('Rollback below deployment floor is forbidden');
      }

      const existing = await tx.blockCursorRollback.findUnique({
        where: { authorizationRef: authorization.authorizationRef },
      });
      if (existing) {
        throw new Error('Rollback authorization already consumed');
      }

      await tx.blockCursorRollback.create({
        data: {
          cursorId: cursor.id,
          chainId,
          releaseId,
          projectionId,
          fromHeight: cursor.processedHeight,
          fromHash: cursor.processedHash,
          toHeight: ancestor.height,
          toHash: ancestor.hash.toLowerCase(),
          reason: authorization.reason,
          authorizedBy: authorization.authorizedBy,
          authorizationRef: authorization.authorizationRef,
          auditData: (authorization.auditData ?? null) as any,
        },
      });

      await tx.blockCursorAncestor.updateMany({
        where: {
          cursorId: cursor.id,
          height: { gt: ancestor.height },
          isCanonical: true,
        },
        data: { isCanonical: false },
      });

      const updated = await tx.blockCursor.updateMany({
        where: { id: cursor.id, version: expectedVersion },
        data: {
          processedHeight: ancestor.height,
          processedHash: ancestor.hash.toLowerCase(),
          lastRollbackId: authorization.authorizationRef,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error('Block cursor CAS conflict on rollback');
      }
    });

    this.logger.warn(
      `Reorg recovery: chain=${chainId} source=${source} release=${releaseId} projection=${projectionId} rewound to height=${ancestor.height} hash=${ancestor.hash} by=${authorization.authorizedBy}`,
    );
  }
}
