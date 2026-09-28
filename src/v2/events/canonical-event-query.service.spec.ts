import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEventQueryService } from './canonical-event-query.service';
import { CanonicalEvent } from './entities/canonical-event.entity';

describe('CanonicalEventQueryService', () => {
  let service: CanonicalEventQueryService;
  let repo: jest.Mocked<Repository<CanonicalEvent>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanonicalEventQueryService,
        {
          provide: getRepositoryToken(CanonicalEvent),
          useValue: {
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(CanonicalEventQueryService);
    repo = module.get(getRepositoryToken(CanonicalEvent));
  });

  it('returns empty results for an empty event-name set', async () => {
    const result = await service.findAfter([], null, 25);
    expect(result).toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns empty results for non-positive batch sizes', async () => {
    const result = await service.findAfter(['EvidenceRegistered'], null, 0);
    expect(result).toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('fetches events strictly after the provided cursor in protocol order', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ id: '1' }]),
    };
    repo.createQueryBuilder.mockReturnValue(qb as never);

    const rows = await service.findAfter(
      ['EvidenceRegistered', 'EvidenceRemoved'],
      { blockNumber: '100', logIndex: 2 },
      50,
    );

    expect(rows).toEqual([{ id: '1' }]);
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
      {
        blockNumber: '100',
        logIndex: 2,
      },
    );
  });

  it('accepts bigint and number cursors by normalizing them to decimal strings', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ id: '2' }]),
    };
    repo.createQueryBuilder.mockReturnValue(qb as never);

    await service.findAfter(['EvidenceRegistered'], { blockNumber: 100n, logIndex: 8 }, 25);
    await service.findAfter(['EvidenceRegistered'], { blockNumber: 200, logIndex: 3 }, 25);

    expect(qb.andWhere).toHaveBeenNthCalledWith(
      1,
      '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
      {
        blockNumber: '100',
        logIndex: 8,
      },
    );
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      2,
      '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
      {
        blockNumber: '200',
        logIndex: 3,
      },
    );
  });
});
