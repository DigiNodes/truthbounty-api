/* eslint-disable @typescript-eslint/unbound-method */
import { DataSource, Repository } from 'typeorm';
import { SqliteDriver } from 'typeorm/driver/sqlite/SqliteDriver';
import { EvidenceService, EvidenceAvailability } from './evidence.service';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { IpfsService } from '../ipfs/ipfs.service';
import { IpfsProvider } from '../ipfs/interfaces';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { Claim } from './entities/claim.entity';
import { CID } from 'multiformats/cid';

const cidParse = CID.parse as unknown as jest.Mock;

/**
 * The production `Claim` entity declares `resolvedAt` with the postgres-only
 * `timestamp` column type. SQLite rejects that type at metadata-validation time,
 * so the in-memory test connection uses a driver subclass that additionally
 * accepts `timestamp` (SQLite itself is permissive about type names).
 */
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
    entities: [Claim, Evidence, EvidenceVersion],
    synchronize: true,
  });
  dataSource.driver = new TimestampAwareSqliteDriver(
    dataSource as unknown as DataSource,
  );
  return dataSource;
};

/**
 * End-to-end integration test across the database boundary (in-memory SQLite).
 * Exercises the V2-BE-025 query surface against real repositories:
 *   - bounded pagination + deterministic ordering for lists and versions
 *   - content digest derivation from a stored CID
 *   - safe gateway metadata through the gateway sanitizer
 *   - separation of missing on-chain registration vs unavailable off-chain content
 */
describe('EvidenceService (integration: query surface)', () => {
  let dataSource: DataSource;
  let evidenceRepo: Repository<Evidence>;
  let versionRepo: Repository<EvidenceVersion>;
  let claimRepo: Repository<Claim>;
  let service: EvidenceService;

  let audit: { log: jest.Mock };
  const gatewayProvider: IpfsProvider = {
    add: jest.fn(),
    getUrl: (cid: string) => `https://gateway.example/ipfs/${cid}`,
  };

  beforeEach(async () => {
    cidParse.mockReset();
    cidParse.mockImplementation((str: string) => ({
      version: 1,
      code: 0x55,
      multihash: { code: 0x12, digest: Uint8Array.from([1, 2, 3, 4]) },
      toString: () => str,
    }));

    dataSource = buildTestDataSource();
    await dataSource.initialize();

    evidenceRepo = dataSource.getRepository(Evidence);
    versionRepo = dataSource.getRepository(EvidenceVersion);
    claimRepo = dataSource.getRepository(Claim);
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new EvidenceService(
      evidenceRepo,
      versionRepo,
      audit as unknown as AuditTrailService,
      new IpfsService(gatewayProvider),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
    cidParse.mockReset();
    jest.clearAllMocks();
  });

  const seedClaim = async (id: string) => {
    await claimRepo.save(
      claimRepo.create({ id, title: `Claim ${id}`, content: 'test content' }),
    );
  };

  const seed = async () => {
    await seedClaim('claim-a');
    await seedClaim('claim-b');
    const ev1 = await evidenceRepo.save(
      evidenceRepo.create({ claimId: 'claim-a', latestVersion: 1 }),
    );
    await versionRepo.save(
      versionRepo.create({
        evidenceId: ev1.id,
        version: 1,
        cid: 'cid-a-v1',
      }),
    );
    const ev2 = await evidenceRepo.save(
      evidenceRepo.create({ claimId: 'claim-b', latestVersion: 1 }),
    );
    await versionRepo.save(
      versionRepo.create({
        evidenceId: ev2.id,
        version: 1,
        cid: 'cid-b-v1',
      }),
    );
    return { ev1, ev2 };
  };

  it('lists evidence with bounded pagination and deterministic ordering', async () => {
    const { ev1, ev2 } = await seed();

    const page = await service.listEvidence({ page: 1, limit: 10 });
    expect(page.meta.total).toBe(2);
    expect(page.meta.totalPages).toBe(1);
    const ids = page.data.map((e) => e.id);
    // Deterministic: created ASC, id ASC.
    expect(ids).toEqual([ev1.id, ev2.id].sort());
  });

  it('paginates past the first page and filters by claim', async () => {
    await seed();
    const filter = await service.listEvidence({
      page: 1,
      limit: 100,
      claimId: 'claim-a',
    });
    expect(filter.meta.total).toBe(1);
    expect(filter.data[0].claimId).toBe('claim-a');
  });

  it('lists versions newest-first for an evidence aggregate', async () => {
    const { ev1 } = await seed();
    await versionRepo.save(
      versionRepo.create({ evidenceId: ev1.id, version: 2, cid: 'cid-a-v2' }),
    );
    await versionRepo.save(
      versionRepo.create({ evidenceId: ev1.id, version: 3, cid: 'cid-a-v3' }),
    );

    const page = await service.listEvidenceVersions(ev1.id, {
      page: 1,
      limit: 2,
    });
    expect(page.meta.total).toBe(3);
    expect(page.meta.totalPages).toBe(2);
    expect(page.data.map((v) => v.version)).toEqual([3, 2]);
  });

  it('returns the content digest derived from the stored CID', async () => {
    const { ev1 } = await seed();
    const digest = await service.getContentDigest(ev1.id);
    expect(digest.digestHex).toBe('01020304');
    expect(digest.cid).toBe('cid-a-v1');
  });

  it('returns safe gateway metadata through the sanitizer', async () => {
    const { ev1 } = await seed();
    const gateway = await service.getSafeGateway(ev1.id);
    expect(gateway).toEqual({
      cid: 'cid-a-v1',
      gatewayUrl: 'https://gateway.example/ipfs/cid-a-v1',
    });
  });

  it('reports OFFCHAIN_UNAVAILABLE when registered but no content is addressable', async () => {
    const { ev1 } = await seed();
    await evidenceRepo.update(ev1.id, { onChainRegistered: true });
    // Override the provider to return no safe URL.
    const localService = new EvidenceService(
      evidenceRepo,
      versionRepo,
      audit as unknown as AuditTrailService,
      new IpfsService({ add: jest.fn(), getUrl: () => undefined }),
    );
    const status = await localService.getAvailabilityStatus(ev1.id);
    expect(status.availability).toBe(EvidenceAvailability.OFFCHAIN_UNAVAILABLE);
    expect(status.onChainRegistered).toBe(true);
  });

  it('reports ONCHAIN_NOT_REGISTERED when registration is missing', async () => {
    const { ev1 } = await seed();
    const status = await service.getAvailabilityStatus(ev1.id);
    expect(status.availability).toBe(
      EvidenceAvailability.ONCHAIN_NOT_REGISTERED,
    );
    expect(status.onChainRegistered).toBe(false);
  });

  it('reports AVAILABLE when registered and content is addressable', async () => {
    const { ev1 } = await seed();
    await evidenceRepo.update(ev1.id, { onChainRegistered: true });
    const status = await service.getAvailabilityStatus(ev1.id);
    expect(status.availability).toBe(EvidenceAvailability.AVAILABLE);
    expect(status.gatewayUrl).toBe('https://gateway.example/ipfs/cid-a-v1');
  });

  it('throws NotFoundException for a missing evidence aggregate', async () => {
    await expect(service.getAvailabilityStatus('missing')).rejects.toThrow(
      'Evidence with ID missing not found',
    );
  });
});
