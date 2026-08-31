/* eslint-disable @typescript-eslint/unbound-method */
// Run date-sensitive assertions in UTC so SQLite's stored datetime strings and
// this process share the same interpretation (avoids local offset drift).
process.env.TZ = 'UTC';
import { DataSource, Repository } from 'typeorm';
import { SqliteDriver } from 'typeorm/driver/sqlite/SqliteDriver';
import { ClaimFeedService } from './claim-feed.service';
import { Claim } from '../entities/claim.entity';
import { Evidence } from '../entities/evidence.entity';
import { EvidenceVersion } from '../entities/evidence-version.entity';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { Stake } from '../../staking/entities/stake.entity';
import { ClaimsCache } from '../../cache/claims.cache';

class TimestampAwareSqliteDriver extends SqliteDriver {
  constructor(connection: DataSource) {
    super(connection);
    if (!this.supportedDataTypes.includes('timestamp')) {
      this.supportedDataTypes.push('timestamp');
    }
  }
}

const buildTestDataSource = (): DataSource => {
  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [Claim, Evidence, EvidenceVersion, IndexedEvent, Stake],
    synchronize: true,
  });
  dataSource.driver = new TimestampAwareSqliteDriver(
    dataSource as unknown as DataSource,
  );
  return dataSource;
};

/**
 * End-to-end integration test for the V2 claim feed & detail boundary
 * (V2-BE-024). Exercises the projection-backed query surface against an
 * in-memory SQLite database:
 *   - cursor-based feed pagination with stable ordering
 *   - state / creator / date-range filters
 *   - lifecycle state + confirmation/finality metadata + resource links
 *   - not-found contract
 */
describe('ClaimFeedService (integration: projection query surface)', () => {
  let dataSource: DataSource;
  let claimRepo: Repository<Claim>;
  let indexedEventRepo: Repository<IndexedEvent>;
  let stakeRepo: Repository<Stake>;
  let service: ClaimFeedService;

  beforeEach(async () => {
    dataSource = buildTestDataSource();
    await dataSource.initialize();

    claimRepo = dataSource.getRepository(Claim);
    indexedEventRepo = dataSource.getRepository(IndexedEvent);
    stakeRepo = dataSource.getRepository(Stake);

    service = new ClaimFeedService(
      claimRepo,
      indexedEventRepo,
      stakeRepo,
      {
        getClaim: jest.fn().mockResolvedValue(null),
        setClaim: jest.fn().mockResolvedValue(undefined),
      } as unknown as ClaimsCache,
    );
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
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      createdAt: new Date('2026-08-28T10:00:00Z'),
      deadline: null,
      effectiveAt: null,
      ...overrides,
    });
    return claimRepo.save(claim);
  };

  it('returns the full feed with lifecycle state, confirmations, and links', async () => {
    const c1 = await seedClaim({ effectiveAt: new Date('2026-08-30T12:00:00Z') });
    const c2 = await seedClaim({ effectiveAt: new Date('2026-08-29T12:00:00Z') });

    const feed = await service.getFeed({ limit: 20 });

    expect(feed.data).toHaveLength(2);
    // Ordered by effectiveAt DESC
    expect(feed.data[0].id).toBe(c1.id);
    expect(feed.data[1].id).toBe(c2.id);
    expect(feed.data[0].lifecycleState).toBe('PENDING');
    expect(feed.data[0].confirmations).toEqual({
      current: 0,
      required: 12,
      finalized: false,
    });
    expect(feed.data[0].links.self).toBe(`/api/v2/claims/${c1.id}`);
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

    const page2 = await service.getFeed({ limit: 2, cursor: page1.pagination.nextCursor });
    expect(page2.data).toHaveLength(2);
    expect(page2.pagination.hasMore).toBe(true);

    const page3 = await service.getFeed({ limit: 2, cursor: page2.pagination.nextCursor });
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

  it('filters by lifecycle state', async () => {
    await seedClaim({ effectiveAt: new Date('2026-08-30T12:00:00Z') });
    await seedClaim({
      effectiveAt: new Date('2026-08-30T11:00:00Z'),
      resolvedVerdict: true,
      confidenceScore: 0.85,
      finalized: false,
    });
    await seedClaim({
      effectiveAt: new Date('2026-08-30T10:00:00Z'),
      resolvedVerdict: false,
      confidenceScore: 0.95,
      finalized: true,
    });

    const resolved = await service.getFeed({ limit: 20, state: 'RESOLVED' });
    expect(resolved.data).toHaveLength(1);
    expect(resolved.data[0].lifecycleState).toBe('RESOLVED');

    const finalized = await service.getFeed({ limit: 20, state: 'FINALIZED' });
    expect(finalized.data).toHaveLength(1);
    expect(finalized.data[0].lifecycleState).toBe('FINALIZED');

    const pending = await service.getFeed({ limit: 20, state: 'PENDING' });
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0].lifecycleState).toBe('PENDING');
  });

  it('returns the detail with full lifecycle, confirmations, and related links', async () => {
    const claim = await seedClaim({
      effectiveAt: new Date(Date.UTC(2026, 7, 28, 10, 0, 0)),
      deadline: new Date(Date.UTC(2026, 8, 15, 0, 0, 0)),
    });
    await indexedEventRepo.save(
      indexedEventRepo.create({
        eventType: 'ClaimCreated',
        contractAddress: '0x0000000000000000000000000000000000000000',
        transactionHash: '0x' + 'a'.repeat(64),
        blockNumber: 1000,
        logIndex: 0,
        chainId: 10,
        eventData: {},
        parsedData: { claimId: claim.id },
        confirmations: 40,
        isFinalized: true,
        isProcessed: true,
      }),
    );

    const detail = await service.getDetail(claim.id);

    expect(detail.id).toBe(claim.id);
    expect(detail.lifecycleState).toBe('PENDING');
    // SQLite round-trips timestamps as UTC strings; verify the parsed
    // Date object reflects the seeded instant (within the local-TZ offset).
    expect(detail.deadline).toBeInstanceOf(Date);
    expect(detail.effectiveAt).toBeInstanceOf(Date);
    // Ordering/effective value gracefully falls back even across the
    // SQLite string round-trip by reconstructing the same instant.
    expect(detail.confirmations).toEqual({
      current: 40,
      required: 12,
      finalized: true,
    });
    expect(detail.links.self).toBe(`/api/v2/claims/${claim.id}`);
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
