import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DisputeEvent, DisputeRelease } from './finalized-dispute-projection';

export interface DisputeWorkflow {
  id: string;
  chainId: number;
  releaseId: string;
  contractAddress: string;
  claimId: string;
  initiatorAddress: string;
  reviewStatus: string;
  reviewedBy: string | null;
  reviewReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Prisma/PostgreSQL boundary per maintainer decision #831. No protocol writes. */
@Injectable()
export class DisputeJournalStore {
  constructor(private readonly prisma: PrismaService) {}

  async events(scope: DisputeRelease): Promise<DisputeEvent[]> {
    // Bound resource use and fail rather than return a truncated history.
    const rows = await this.prisma.$queryRaw<DisputeEvent[]>`
      SELECT "chainId", "releaseId", "contractAddress", "decoderVersion", "eventName",
             "blockNumber", "blockHash", "txHash", "logIndex", "payload", "removed"
      FROM "ChainEvent"
      WHERE "chainId" = ${scope.chainId} AND "releaseId" = ${scope.releaseId}
        AND lower("contractAddress") = ${scope.contractAddress}
        AND "decoderVersion" = ${scope.decoderVersion} AND "removed" = false
        AND "eventName" IN ('DisputeRaised', 'DisputeResolved', 'DisputeExpired')
      LIMIT 10001`;
    if (rows.length > 10000)
      throw new Error('Dispute replay history exceeds supported bound');
    return rows;
  }

  workflows(scope: DisputeRelease): Promise<DisputeWorkflow[]> {
    return this.prisma.$queryRaw<DisputeWorkflow[]>`
      SELECT * FROM "DisputeWorkflow"
      WHERE "chainId" = ${scope.chainId} AND "releaseId" = ${scope.releaseId}
        AND "contractAddress" = ${scope.contractAddress}
      ORDER BY "createdAt" DESC, "id" ASC LIMIT 10001`;
  }

  async create(
    scope: DisputeRelease,
    claimId: string,
    actor: string,
    metadata: Record<string, unknown>,
  ) {
    const rows = await this.prisma.$queryRaw<DisputeWorkflow[]>`
      INSERT INTO "DisputeWorkflow"
        ("id", "chainId", "releaseId", "contractAddress", "claimId", "initiatorAddress", "metadata", "updatedAt")
      VALUES (${randomUUID()}, ${scope.chainId}, ${scope.releaseId}, ${scope.contractAddress},
        ${claimId}, ${actor}, ${JSON.stringify(metadata)}::jsonb, CURRENT_TIMESTAMP)
      RETURNING *`;
    return rows[0];
  }

  async review(
    scope: DisputeRelease,
    id: string,
    actor: string,
    status: string,
    reason: string | null,
  ) {
    const rows = await this.prisma.$queryRaw<DisputeWorkflow[]>`
      UPDATE "DisputeWorkflow" SET "reviewStatus" = ${status}, "reviewedBy" = ${actor},
        "reviewReason" = ${reason}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "chainId" = ${scope.chainId} AND "releaseId" = ${scope.releaseId}
        AND "contractAddress" = ${scope.contractAddress}
      RETURNING *`;
    return rows[0] ?? null;
  }
}
