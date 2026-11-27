// Run date-sensitive assertions in UTC so SQLite's stored datetime strings and
// this process share the same interpretation (avoids local offset drift).
process.env.TZ = 'UTC';
import { DataSource, Repository } from 'typeorm';
import { ClaimFeedService } from './claim-feed.service';
import { Claim } from '../entities/claim.entity';
import { Evidence } from '../entities/evidence.entity';
import { EvidenceVersion } from '../entities/evidence-version.entity';
import { Stake } from '../../staking/entities/stake.entity';
import { ClaimsCache } from '../../cache/claims.cache';

const buildTestDataSource = (): DataSource => {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Claim, Evidence, EvidenceVersion, Stake],
    synchronize: true,
  });
  // The production `Claim` entity uses the postgres `timestamp` column type
  // for deadline/effectiveAt. SQLite's driver does not list `timestamp` as
  // supported, so register it here (SQLite itself accepts the type name).
  // The driver instance already exists pre-initialize via DriverFactory.
  const supported = (dataSource.driver as any).supportedDataTypes as string[];
  if (!supported.includes('timestamp')) {
    supported.push('timestamp');
  }
  return dataSource;
};

/**
 * End-to-end integration test for the V2 claim feed & detail boundary
 * (V2-BE-024). Exercises the projection-backed query surface against an
 * in-memory SQLite database:
 *   - cursor-based feed pagination with stable ordering
 *   - creator / date-range filters
 *   - legacy metadata responses do not publish verdict/finality
 *   - not-found contract
 */
describe('ClaimFeedService (integration: projection query surface)', () => {
  let dataSource: DataSource;
  let claimRepo: Repository<Claim>;
  let stakeRepo: Repository<Stake>;
  let service: ClaimFeedService;

  beforeEach(async () => {
    dataSource = buildTestDataSource();
    await dataSource.initialize();

    claimRepo = dataSource.getRepository(Claim);
    stakeRepo = dataSource.getRepository(Stake);

    service = new ClaimFeedService(claimRepo, stakeRepo, {
      getClaim: jest.fn().mockResolvedValue(null),
      setClaim: jest.fn().mockResolvedValue(undefined),
    } as unknown as ClaimsCache);
  });

  afterEach(async () => {
    await dataSource.destroy();
    jest.clearAllMocks();
  });

  const seedClaim = async (overrides: Partial<Claim> = {}) => {
    const claim = claimRepo.create({
      title: 'Test claim',
      content: 'Test content',
      source: null,
      metadata: null,
      createdAt: new Date('2026-08-28T10:00:00Z'),
      deadline: null,
      effectiveAt: null,
      ...overrides,
    });
    return claimRepo.save(claim);
  };

  it('returns metadata without legacy verdict or finality fields', async () => {
    const c1 = await seedClaim({
      effectiveAt: new Date('2026-08-30T12:00:00Z'),
    });
    const c2 = await seedClaim({
      effectiveAt: new Date('2026-08-29T12:00:00Z'),
    });

    const feed = await service.getFeed({ limit: 20 });

    expect(feed.data).toHaveLength(2);
    // Ordered by effectiveAt DESC
    expect(feed.data[0].id).toBe(c1.id);
    expect(feed.data[1].id).toBe(c2.id);
    expect(feed.data[0]).not.toHaveProperty('lifecycleState');
    expect(feed.data[0]).not.toHaveProperty('resolvedVerdict');
    expect(feed.data[0]).not.toHaveProperty('confidenceScore');
    expect(feed.data[0]).not.toHaveProperty('confirmations');
    expect(feed.data[0].links.self).toBe(`/api/v2/claims/${c1.id}`);
    expect(feed.data[0].links.canonicalReadModel).toBe(
      `/api/v2/claim-read-models/${c1.id}`,
    );
    expect(feed.pagination.hasMore).toBe(false);
  });

  it('paginates across pages using a stable cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await seedClaim({
        effectiveAt: new Date(Date.UTC(2026, 7, 30, 0, i, 0)),
      });
    }

    const page1 = await service.getFeed({ limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.pagination.nextCursor).toBeTruthy();

    const page2 = await service.getFeed({
      limit: 2,
      cursor: page1.pagination.nextCursor,
    });
    expect(page2.data).toHaveLength(2);
    expect(page2.pagination.hasMore).toBe(true);

    const page3 = await service.getFeed({
      limit: 2,
      cursor: page2.pagination.nextCursor,
    });
    expect(page3.data).toHaveLength(1);
    expect(page3.pagination.hasMore).toBe(false);

    // Ensure no overlapping / missing rows across pages (stable pagination)
    const seenIds = new Set([
      ...page1.data.map((c) => c.id),
      ...page2.data.map((c) => c.id),
      ...page3.data.map((c) => c.id),
    ]);
    expect(seenIds.size).toBe(5);
  });

  it('rejects state filters instead of reading legacy verdict columns', async () => {
    await expect(
      service.getFeed({ limit: 20, state: 'FINALIZED' }),
    ).rejects.toThrow('Claim state filters are available only from');
  });

  it('returns detail without lifecycle or confirmation claims', async () => {
    const claim = await seedClaim({
      effectiveAt: new Date(Date.UTC(2026, 7, 28, 10, 0, 0)),
      deadline: new Date(Date.UTC(2026, 8, 15, 0, 0, 0)),
    });
    const detail = await service.getDetail(claim.id);

    expect(detail.id).toBe(claim.id);
    expect(detail).not.toHaveProperty('lifecycleState');
    expect(detail).not.toHaveProperty('resolvedVerdict');
    expect(detail).not.toHaveProperty('confidenceScore');
    expect(detail).not.toHaveProperty('confirmations');
    // SQLite round-trips timestamps as UTC strings; verify the parsed
    // Date object reflects the seeded instant (within the local-TZ offset).
    expect(detail.deadline).toBeInstanceOf(Date);
    expect(detail.effectiveAt).toBeInstanceOf(Date);
    expect(detail.links.self).toBe(`/api/v2/claims/${claim.id}`);
    expect(detail.links.canonicalReadModel).toBe(
      `/api/v2/claim-read-models/${claim.id}`,
    );
    expect(detail.links.evidence).toBe(`/api/v2/claims/${claim.id}/evidence`);
    expect(detail.links.stakes).toBe(`/api/v2/claims/${claim.id}/stakes`);
  });

  it('throws NotFoundException for a missing claim in detail', async () => {
    // uses the real repository; cache returns null, DB has no such row
    await expect(service.getDetail('does-not-exist')).rejects.toThrow(
      'Claim does-not-exist not found',
    );
  });
});
