import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEvent } from './entities/canonical-event.entity';

/**
 * Read-only access to canonical events for downstream V2 projectors
 * (evidence, verification, disputes). Ordering is always
 * (blockNumber, logIndex) ascending -- the deterministic protocol order --
 * never insertion order or id.
 */
@Injectable()
export class CanonicalEventQueryService {
  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
  ) {}

  private normalizeBlockNumber(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return trimmed;
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) return null;
      return String(value);
    }
    if (typeof value === 'bigint') {
      if (value < 0n) return null;
      return value.toString();
    }
    return null;
  }

  /**
   * Fetch events by name, strictly after the given (blockNumber, logIndex)
   * order key, in ascending protocol order. Pass `null` to start from genesis.
   */
  async findAfter(
    eventNames: string[],
    after: { blockNumber: string | number | bigint; logIndex: number } | null,
    limit: number,
  ): Promise<CanonicalEvent[]> {
    if (!Array.isArray(eventNames) || eventNames.length === 0) return [];
    if (!Number.isInteger(limit) || limit <= 0) return [];

    const normalizedBlockNumber =
      after !== null && after !== undefined
        ? this.normalizeBlockNumber(after.blockNumber)
        : null;
    const hasCursor =
      after !== null &&
      after !== undefined &&
      normalizedBlockNumber !== null &&
      Number.isInteger(after.logIndex);

    const qb = this.events
      .createQueryBuilder('e')
      .where('e.eventName IN (:...eventNames)', { eventNames })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .limit(limit);

    if (hasCursor) {
      qb.andWhere(
        '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
        {
          blockNumber: normalizedBlockNumber,
          logIndex: after.logIndex,
        },
      );
    }

    return qb.getMany();
  }
}
