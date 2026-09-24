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

  /**
   * Fetch events by name, strictly after the given (blockNumber, logIndex)
   * order key, in ascending protocol order. Pass `null` to start from genesis.
   */
  async findAfter(
    eventNames: string[],
    after: { blockNumber: string; logIndex: number } | null,
    limit: number,
  ): Promise<CanonicalEvent[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .where('e.eventName IN (:...eventNames)', { eventNames })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .limit(limit);

    if (after) {
      qb.andWhere(
        '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
        {
          blockNumber: after.blockNumber,
          logIndex: after.logIndex,
        },
      );
    }

    return qb.getMany();
  }
}
