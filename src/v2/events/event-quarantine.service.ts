import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { RawLog } from './interfaces/canonical-event.interface';
import {
  EventQuarantine,
  QuarantineFailureKind,
  QuarantineReason,
  QuarantineStatus,
} from './entities/event-quarantine.entity';

/** Detail text is capped so a hostile/buggy decoder cannot bloat the table. */
export const MAX_QUARANTINE_DETAIL_LEN = 512;
/** Largest raw payload retained for replay; larger logs keep only their hash. */
export const MAX_RETAINED_RAW_BYTES = 64 * 1024;

/** Privacy-safe projection of a quarantine row (no raw payload, no free text). */
export interface QuarantineRecordView {
  id: string;
  chainId: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  topic0: string | null;
  reason: QuarantineReason;
  failureKind: QuarantineFailureKind | null;
  status: QuarantineStatus;
  artifactVersion: string | null;
  abiChecksum: string | null;
  eventSignature: string | null;
  dataHash: string | null;
  dataLength: number | null;
  topicCount: number | null;
  replayAttempts: number;
  replayedAt: Date | null;
  replayedBy: string | null;
  lastReplayErrorCode: string | null;
  quarantinedAt: Date;
  retentionUntil: Date | null;
}

export interface RecordQuarantineInput {
  log: RawLog;
  reason: QuarantineReason;
  failureKind: QuarantineFailureKind;
  detail: string;
  artifactVersion?: string | null;
  abiChecksum?: string | null;
  eventSignature?: string | null;
}

export interface QuarantineListQuery {
  chainId?: number;
  reason?: QuarantineReason;
  status?: QuarantineStatus;
  limit?: number;
  offset?: number;
}

export interface QuarantinePage {
  items: QuarantineRecordView[];
  total: number;
  limit: number;
  offset: number;
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Durable, bounded, privacy-safe store for undecodable contract events
 * (PREWAVE-BE-053, #647).
 *
 * Writes happen before any canonical event/projection write, so a quarantined
 * log can never mutate projections. Reads never expose the raw payload or
 * free-form detail; replay consumes the raw payload internally.
 */
@Injectable()
export class EventQuarantineService {
  private readonly logger = new Logger(EventQuarantineService.name);

  constructor(
    @InjectRepository(EventQuarantine)
    private readonly repo: Repository<EventQuarantine>,
  ) {}

  /** Persist a bounded quarantine record. Idempotent per (chainId,txHash,logIndex). */
  async record(input: RecordQuarantineInput): Promise<void> {
    const { log } = input;
    const topics = Array.isArray(log.topics) ? log.topics.slice(0, 8) : [];
    const data = typeof log.data === 'string' ? log.data : '';
    const dataBytes = Math.max(0, Math.floor((data.length - 2) / 2));
    const dataHash = `0x${createHash('sha256')
      .update(`${topics.join(':')}|${data}`)
      .digest('hex')}`;

    const retainRaw = dataBytes <= MAX_RETAINED_RAW_BYTES;
    const rawLog: Record<string, unknown> = retainRaw
      ? { topics, data }
      : { topics, data: null, truncated: true, dataHash };

    try {
      await this.repo.insert({
        chainId: log.chainId,
        contractAddress: log.address.toLowerCase(),
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber.toString(),
        topic0: topics[0] ?? null,
        reason: input.reason,
        failureKind: input.failureKind,
        status: QuarantineStatus.OPEN,
        rawLog: rawLog as object,
        detail: input.detail.slice(0, MAX_QUARANTINE_DETAIL_LEN),
        artifactVersion: input.artifactVersion ?? null,
        abiChecksum: input.abiChecksum ?? null,
        eventSignature: input.eventSignature ?? null,
        dataHash,
        dataLength: dataBytes,
        topicCount: topics.length,
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      // Already quarantined for this identity; replay/ingest is idempotent.
    }
  }

  async list(query: QuarantineListQuery = {}): Promise<QuarantinePage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);

    const qb = this.repo.createQueryBuilder('q');
    qb.where('q.status = :status', {
      status: query.status ?? QuarantineStatus.OPEN,
    });
    if (query.chainId !== undefined) {
      qb.andWhere('q.chainId = :chainId', { chainId: query.chainId });
    }
    if (query.reason !== undefined) {
      qb.andWhere('q.reason = :reason', { reason: query.reason });
    }
    qb.orderBy('q.quarantinedAt', 'ASC').skip(offset).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((row) => this.toView(row)), total, limit, offset };
  }

  async get(id: string): Promise<QuarantineRecordView> {
    return this.toView(await this.getRaw(id));
  }

  /** Internal: full row, including the retained raw payload (replay only). */
  async getRaw(id: string): Promise<EventQuarantine> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Quarantine record ${id} not found`);
    return row;
  }

  /** Count of rows still blocking readiness. */
  async getBlockingCount(chainId?: number): Promise<number> {
    const qb = this.repo
      .createQueryBuilder('q')
      .where('q.status = :status', { status: QuarantineStatus.OPEN });
    if (chainId !== undefined) {
      qb.andWhere('q.chainId = :chainId', { chainId });
    }
    return qb.getCount();
  }

  /** Open quarantine counts by reason, for readiness/observability. */
  async getOpenCountByReason(
    chainId?: number,
  ): Promise<Record<string, number>> {
    const qb = this.repo
      .createQueryBuilder('q')
      .select('q.reason', 'reason')
      .addSelect('COUNT(*)', 'count')
      .where('q.status = :status', { status: QuarantineStatus.OPEN })
      .groupBy('q.reason');
    if (chainId !== undefined) {
      qb.andWhere('q.chainId = :chainId', { chainId });
    }

    const rows = await qb.getRawMany<{ reason: string; count: string }>();
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.reason] = Number(row.count);
      return acc;
    }, {});
  }

  /** Mark a quarantine row replayed and scrub the retained raw payload. */
  async markReplayed(
    id: string,
    details: {
      replayedBy: string;
      artifactVersion: string;
      retentionUntil: Date;
    },
  ): Promise<void> {
    await this.repo.increment({ id }, 'replayAttempts', 1);
    await this.repo.update(
      { id },
      {
        status: QuarantineStatus.REPLAYED,
        replayedAt: new Date(),
        replayedBy: details.replayedBy,
        artifactVersion: details.artifactVersion,
        lastReplayErrorCode: null,
        retentionUntil: details.retentionUntil,
        rawLog: null,
        detail: null,
      },
    );
    this.logger.log(`Quarantine ${id} replayed by ${details.replayedBy}`);
  }

  async markReplayFailed(id: string, errorCode: string): Promise<void> {
    await this.repo.increment({ id }, 'replayAttempts', 1);
    await this.repo.update(
      { id },
      { lastReplayErrorCode: errorCode.slice(0, 64) },
    );
  }

  private toView(row: EventQuarantine): QuarantineRecordView {
    return {
      id: row.id,
      chainId: row.chainId,
      contractAddress: row.contractAddress,
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: row.blockNumber,
      topic0: row.topic0,
      reason: row.reason,
      failureKind: row.failureKind,
      status: row.status,
      artifactVersion: row.artifactVersion,
      abiChecksum: row.abiChecksum,
      eventSignature: row.eventSignature,
      dataHash: row.dataHash,
      dataLength: row.dataLength,
      topicCount: row.topicCount,
      replayAttempts: row.replayAttempts,
      replayedAt: row.replayedAt,
      replayedBy: row.replayedBy,
      lastReplayErrorCode: row.lastReplayErrorCode,
      quarantinedAt: row.quarantinedAt,
      retentionUntil: row.retentionUntil,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
  }
}
