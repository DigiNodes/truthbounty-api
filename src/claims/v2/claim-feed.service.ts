import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { Claim } from '../entities/claim.entity';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { Stake } from '../../staking/entities/stake.entity';
import { ClaimFeedQueryDto, CLAIM_FEED_MAX_LIMIT } from './dto/claim-feed-query.dto';
import { ClaimsCache } from '../../cache/claims.cache';

const DEFAULT_CONFIRMATIONS_REQUIRED = 12;

interface CursorPayload {
  effectiveAt: string;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed.effectiveAt || !parsed.id) {
      throw new Error('Invalid cursor structure');
    }
    return parsed as CursorPayload;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/**
 * Coerce a timestamp that may be stored as a string (e.g. SQLite) into a
 * Date instance. In production (PostgreSQL) these are already Date values.
 */
function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Returns the epoch (milliseconds UTC) for a timestamp value read from the DB.
 * Postgres returns a Date (getTime is exact). SQLite returns a datetime string
 * like "2026-08-30 00:03:00.000" which SqliteRuntime stores as UTC; strftime
 * ('%s', col) and strftime('%f') read that string as UTC, so we mirror that
 * interpretation here to keep the cursor sort key consistent with the column.
 */
function toEpochMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const iso = value.includes('T')
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

@Injectable()
export class ClaimFeedService {
  private readonly logger = new Logger(ClaimFeedService.name);

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    @InjectRepository(IndexedEvent)
    private readonly indexedEventRepo: Repository<IndexedEvent>,
    @InjectRepository(Stake)
    private readonly stakeRepo: Repository<Stake>,
    private readonly claimsCache: ClaimsCache,
  ) {}

  async getFeed(query: ClaimFeedQueryDto): Promise<{
    data: any[];
    pagination: { nextCursor: string | null; hasMore: boolean };
  }> {
    const limit = Math.min(Math.max(query.limit, 1), CLAIM_FEED_MAX_LIMIT);
    const qb = this.claimRepo.createQueryBuilder('claim');

    // Cursor-based pagination. Timestamps are compared as epoch values so the
    // comparison is identical across SQLite and PostgreSQL regardless of how
    // each driver serializes datetime parameters.
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      // Bind the epoch as a string: SQLite's strftime('%s', ...) returns text and
      // text-vs-integer comparisons are coerced inconsistently, while the string
      // form compares correctly on both SQLite and PostgreSQL.
      const cursorEpoch = String(new Date(cursor.effectiveAt).getTime() / 1000);
      const epoch = this.epochExpression('claim."effectiveAt"');
      qb.where(
        `(${epoch} < :cursorEpoch) OR (${epoch} = :cursorEpoch AND claim.id < :cursorId)`,
        { cursorEpoch, cursorId: cursor.id },
      );
    }

    // State filter — derive from entity fields
    if (query.state) {
      switch (query.state) {
        case 'PENDING':
          qb.andWhere('claim."resolvedVerdict" IS NULL AND claim."confidenceScore" IS NULL AND claim.finalized = :f', { f: false });
          break;
        case 'RESOLVED':
          qb.andWhere('claim."resolvedVerdict" IS NOT NULL AND claim."confidenceScore" IS NOT NULL AND claim.finalized = :f', { f: false });
          break;
        case 'FINALIZED':
          qb.andWhere('claim.finalized = :f', { f: true });
          break;
      }
    }

    // Creator filter via stake join
    if (query.creator) {
      qb.innerJoin(
        Stake,
        'stake',
        'stake."claimId" = claim.id AND stake."walletAddress" = :creator',
        { creator: query.creator },
      );
    }

    // Date range filter
    if (query.from) {
      qb.andWhere('claim."effectiveAt" >= :fromDate', { fromDate: new Date(query.from) });
    }
    if (query.to) {
      qb.andWhere('claim."effectiveAt" <= :toDate', { toDate: new Date(query.to) });
    }

    // Stable ordering
    qb.orderBy('claim."effectiveAt"', 'DESC')
      .addOrderBy('claim.id', 'DESC')
      .take(limit + 1); // fetch one extra to determine hasMore

    const claims = await qb.getMany();
    const hasMore = claims.length > limit;
    const page = hasMore ? claims.slice(0, limit) : claims;

    // Normalize the raw (possibly SQLite-string) effectiveAt before encoding
    // so the cursor carries a canonical instant independent of process timezone.
    const last = page[page.length - 1];
    const nextCursor = hasMore && page.length > 0
      ? encodeCursor({
          effectiveAt: new Date(
            toEpochMillis(last.effectiveAt ?? last.createdAt) ?? Date.now(),
          ).toISOString(),
          id: last.id,
        })
      : null;

    const data = await Promise.all(
      page.map((claim) => this.toFeedItem(claim)),
    );

    return {
      data,
      pagination: { nextCursor, hasMore },
    };
  }

  async getDetail(id: string): Promise<any> {
    let claim = await this.claimsCache.getClaim(id);
    if (!claim) {
      claim = await this.claimRepo.findOneBy({ id });
      if (claim) {
        await this.claimsCache.setClaim(id, claim);
      }
    }
    if (!claim) {
      throw new NotFoundException(`Claim ${id} not found`);
    }

    const confirmations = await this.getConfirmations(claim.id);

    return {
      id: claim.id,
      title: claim.title,
      content: claim.content,
      source: claim.source,
      metadata: claim.metadata,
      lifecycleState: claim.getCurrentState(),
      confidenceScore: claim.confidenceScore,
      resolvedVerdict: claim.resolvedVerdict,
      deadline: normalizeDate(claim.deadline),
      resolvedAt: normalizeDate(claim.resolvedAt),
      effectiveAt: normalizeDate(claim.effectiveAt ?? claim.createdAt),
      createdAt: normalizeDate(claim.createdAt),
      confirmations,
      links: {
        self: `/api/v2/claims/${claim.id}`,
        evidence: `/api/v2/claims/${claim.id}/evidence`,
        stakes: `/api/v2/claims/${claim.id}/stakes`,
      },
    };
  }

  private async toFeedItem(claim: Claim): Promise<any> {
    const confirmations = await this.getConfirmations(claim.id);

    return {
      id: claim.id,
      title: claim.title,
      lifecycleState: claim.getCurrentState(),
      confidenceScore: claim.confidenceScore,
      resolvedVerdict: claim.resolvedVerdict,
      deadline: normalizeDate(claim.deadline),
      effectiveAt: normalizeDate(claim.effectiveAt ?? claim.createdAt),
      createdAt: normalizeDate(claim.createdAt),
      confirmations,
      links: {
        self: `/api/v2/claims/${claim.id}`,
        evidence: `/api/v2/claims/${claim.id}/evidence`,
      },
    };
  }

  private async getConfirmations(claimId: string): Promise<{
    current: number;
    required: number;
    finalized: boolean;
  }> {
    const event = await this.indexedEventRepo.findOne({
      where: { eventType: 'ClaimCreated' },
      order: { blockNumber: 'DESC' },
    });

    // If no indexed event found, return default values
    if (!event) {
      return {
        current: 0,
        required: DEFAULT_CONFIRMATIONS_REQUIRED,
        finalized: false,
      };
    }

    const current = event.confirmations;
    const required = DEFAULT_CONFIRMATIONS_REQUIRED;

    return {
      current,
      required,
      finalized: current >= required || event.isFinalized,
    };
  }

  /**
   * SQL expression that yields the Unix epoch of a timestamp column, portable
   * across SQLite (strftime) and PostgreSQL (EXTRACT EPOCH). Used so cursor
   * pagination compares epochs identically on either database.
   */
  private epochExpression(column: string): string {
    const driver = this.claimRepo.manager.connection.options.type;
    if (driver === 'postgres') {
      return `EXTRACT(EPOCH FROM ${column})`;
    }
    return `strftime('%s', ${column})`;
  }
}
