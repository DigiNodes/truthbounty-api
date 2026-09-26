import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/client/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ChainEventIdentity,
  ChainEventIngestOutcome,
  RawChainLog,
} from './chain-event.types';

const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Deduplicates chain events by canonical log identity: (chainId, blockHash,
 * txHash, logIndex).
 *
 * blockHash is part of the identity deliberately, not incidentally. After a
 * reorg, the same (txHash, logIndex) can legitimately reappear under a
 * *different* blockHash once the transaction is re-included in the
 * replacement chain. Keying only on (chainId, txHash, logIndex) would treat
 * that valid replacement-chain log as a duplicate of the orphaned original
 * and silently drop it. Keying on the full 4-tuple rejects true duplicates
 * (an exact replay of the same log) while still accepting the
 * replacement-chain log as a distinct row.
 *
 * This service is an indexing/read boundary only: it records what the chain
 * emitted. It never computes or mutates settlement, reward, treasury, or
 * governance state — that authority stays on-chain.
 */
@Injectable()
export class ChainEventDedupService {
  private readonly logger = new Logger(ChainEventDedupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingest one raw log. Idempotent: replaying the exact same
   * (chainId, blockHash, txHash, logIndex) is a no-op on the second and
   * subsequent calls.
   */
  async ingest(log: RawChainLog): Promise<ChainEventIngestOutcome> {
    try {
      const created = await this.prisma.chainEvent.create({
        data: {
          chainId: log.chainId,
          contractAddress: log.contractAddress.toLowerCase(),
          eventName: log.eventName,
          blockNumber: log.blockNumber.toString(),
          blockHash: log.blockHash.toLowerCase(),
          txHash: log.txHash.toLowerCase(),
          logIndex: log.logIndex,
          blockTimestamp: log.blockTimestamp ?? null,
          payload: log.payload as Prisma.InputJsonValue,
          rawArgs: log.rawArgs as Prisma.InputJsonValue,
        },
      });
      return { status: 'ingested', id: created.id };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.debug(
          `Duplicate chain event rejected: chain=${log.chainId} ` +
            `block=${log.blockHash} tx=${log.txHash} logIndex=${log.logIndex}`,
        );
        return { status: 'duplicate' };
      }
      throw err;
    }
  }

  /** True if a log with this exact canonical identity has already been recorded. */
  async exists(identity: ChainEventIdentity): Promise<boolean> {
    const row = await this.prisma.chainEvent.findUnique({
      where: {
        chainId_blockHash_txHash_logIndex: {
          chainId: identity.chainId,
          blockHash: identity.blockHash.toLowerCase(),
          txHash: identity.txHash.toLowerCase(),
          logIndex: identity.logIndex,
        },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * All recorded rows for a given (chainId, txHash, logIndex) regardless of
   * blockHash. More than one row here means the same log position has been
   * observed under multiple block hashes — i.e. this tx/log survived a
   * reorg under a different block. Useful for indexer diagnostics and for
   * distinguishing "true duplicate" from "replacement-chain log" in logs.
   */
  async findAcrossBlockHashes(
    chainId: number,
    txHash: string,
    logIndex: number,
  ) {
    return this.prisma.chainEvent.findMany({
      where: {
        chainId,
        txHash: txHash.toLowerCase(),
        logIndex,
      },
      orderBy: { ingestedAt: 'asc' },
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_VIOLATION
    );
  }
}
