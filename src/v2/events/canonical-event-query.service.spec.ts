import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEventQueryService } from './canonical-event-query.service';
import { CanonicalEvent } from './entities/canonical-event.entity';

describe('CanonicalEventQueryService', () => {
  let service: CanonicalEventQueryService;
  let repo: jest.Mocked<Repository<CanonicalEvent>>;
  const scopeConfig = {
    CHAIN_ID: 10,
    CONTRACT_RELEASE_DEPLOYMENT_BLOCK: 100,
    CONTRACT_RELEASE_ID: 'op-mainnet-v1',
    CONTRACT_RELEASE_SHA256: 'a'.repeat(64),
  };

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
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => scopeConfig[key as keyof typeof scopeConfig],
          },
        },
      ],
    }).compile();

    service = module.get(CanonicalEventQueryService);
    repo = module.get(getRepositoryToken(CanonicalEvent));
  });

  it('returns empty results for an empty event-name set', async () => {
    const result = await service.findAfter([], { chainId: 10 }, null, 25);
    expect(result).toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('returns empty results for non-positive batch sizes', async () => {
    const result = await service.findAfter(
      ['EvidenceRegistered'],
      { chainId: 10 },
      null,
      0,
    );
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
      { chainId: 10 },
      { blockNumber: '100', logIndex: 2 },
      50,
    );

    expect(rows).toEqual([{ id: '1' }]);
    expect(qb.where).toHaveBeenCalledWith('e.chainId = :chainId', {
      chainId: 10,
    });
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      1,
      'e.blockNumber >= :deploymentBlock',
      { deploymentBlock: '100' },
    );
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      2,
      'e.artifactVersion = :releaseId',
      { releaseId: 'op-mainnet-v1' },
    );
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      4,
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

    await service.findAfter(
      ['EvidenceRegistered'],
      { chainId: 10 },
      { blockNumber: 100n, logIndex: 8 },
      25,
    );
    await service.findAfter(
      ['EvidenceRegistered'],
      { chainId: 10 },
      { blockNumber: 200, logIndex: 3 },
      25,
    );

    expect(qb.andWhere).toHaveBeenNthCalledWith(
      4,
      '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
      {
        blockNumber: '100',
        logIndex: 8,
      },
    );
    expect(qb.andWhere).toHaveBeenNthCalledWith(
      8,
      '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
      {
        blockNumber: '200',
        logIndex: 3,
      },
    );
  });

  it('fails closed without a complete configured chain and release binding', async () => {
    const invalid = new CanonicalEventQueryService(
      repo,
      { get: () => undefined } as never,
    );
    await expect(
      invalid.findAfter(['EvidenceRegistered'], null, 25),
    ).rejects.toThrow('Canonical event projector scope is not configured');
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('gives each chain/release binding an independent cursor identity', () => {
    const mainnet = service.getScopedProjectorName('v2-evidence');
    const otherScope = new CanonicalEventQueryService(
      repo,
      {
        get: (key: string) =>
          key === 'CHAIN_ID'
            ? 11155420
            : scopeConfig[key as keyof typeof scopeConfig],
      } as never,
    );
    expect(otherScope.getScopedProjectorName('v2-evidence')).not.toBe(mainnet);
  });
});
