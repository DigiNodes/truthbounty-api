import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EvidenceProjectorService } from './evidence-projector.service';
import { EvidenceQueryService } from './evidence-query.service';
import {
  ProjectEvidence,
  EvidenceStatus,
} from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';

describe('EvidenceProjectorService (integration)', () => {
  let moduleRef: TestingModule;
  let projector: EvidenceProjectorService;
  let queryService: EvidenceQueryService;
  let dataSource: DataSource;

  const claimId = '0x' + '11'.repeat(32);

  async function seedEvent(overrides: Partial<CanonicalEvent>): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: '0x' + 'aa'.repeat(20),
      artifactVersion: 'v1',
      txHash: '0x' + '00'.repeat(32),
      logIndex: 0,
      blockNumber: '1',
      claimId,
      actor: '0x' + '22'.repeat(20),
      payload: {} as object,
      rawArgs: {} as object,
      ...overrides,
    });
  }

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('sqlite3'),
          entities: [
            CanonicalEvent,
            ProjectEvidence,
            ProjectEvidenceVersion,
            ProjectorCursor,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          ProjectEvidence,
          ProjectEvidenceVersion,
          ProjectorCursor,
          CanonicalEvent,
        ]),
      ],
      providers: [
        EvidenceProjectorService,
        EvidenceQueryService,
        CanonicalEventQueryService,
      ],
    }).compile();

    projector = moduleRef.get(EvidenceProjectorService);
    queryService = moduleRef.get(EvidenceQueryService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('projects EvidenceRegistered into a version-1 read model', async () => {
    await seedEvent({
      eventName: 'EvidenceRegistered',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      logIndex: 0,
      payload: { digest: '0xdigest1' },
    });

    const summary = await projector.processNewEvents();
    expect(summary).toEqual({ processed: 1, applied: 1, duplicates: 0 });

    const evidence = await queryService.getEvidence(claimId);
    expect(evidence.currentVersion).toBe(1);
    expect(evidence.status).toBe(EvidenceStatus.ACTIVE);
    expect(evidence.contentDigest).toBe('0xdigest1');
  });

  it('EvidenceReplaced appends a new version and bumps currentVersion without deleting history', async () => {
    await seedEvent({
      eventName: 'EvidenceRegistered',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      logIndex: 0,
      payload: { digest: '0xdigest1' },
    });
    await seedEvent({
      eventName: 'EvidenceReplaced',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '110',
      logIndex: 0,
      payload: { digest: '0xdigest2' },
    });

    await projector.processNewEvents();

    const evidence = await queryService.getEvidence(claimId);
    expect(evidence.currentVersion).toBe(2);
    expect(evidence.contentDigest).toBe('0xdigest2');

    const page = await queryService.listVersions(evidence.evidenceId);
    expect(page.items.map((v) => v.version)).toEqual([1, 2]);
    expect(page.items.map((v) => v.contentDigest)).toEqual([
      '0xdigest1',
      '0xdigest2',
    ]);
  });

  it('EvidenceRemoved marks status removed but preserves version history', async () => {
    await seedEvent({
      eventName: 'EvidenceRegistered',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      logIndex: 0,
      payload: { digest: '0xdigest1' },
    });
    await seedEvent({
      eventName: 'EvidenceRemoved',
      txHash: '0x' + '03'.repeat(32),
      blockNumber: '120',
      logIndex: 0,
      payload: {},
    });

    await projector.processNewEvents();

    const evidence = await queryService.getEvidence(claimId);
    expect(evidence.status).toBe(EvidenceStatus.REMOVED);

    const page = await queryService.listVersions(evidence.evidenceId);
    expect(page.items).toHaveLength(1);
  });

  it('is replay-safe: running the projector twice over the same events does not duplicate state', async () => {
    await seedEvent({
      eventName: 'EvidenceRegistered',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      logIndex: 0,
      payload: { digest: '0xdigest1' },
    });

    await projector.processNewEvents();
    const secondRun = await projector.processNewEvents();

    // Second run should see zero new events since the cursor advanced.
    expect(secondRun).toEqual({ processed: 0, applied: 0, duplicates: 0 });

    const evidence = await queryService.getEvidence(claimId);
    expect(evidence.currentVersion).toBe(1);
    const versions = await dataSource
      .getRepository(ProjectEvidenceVersion)
      .find();
    expect(versions).toHaveLength(1);
  });

  it('provides deterministic keyset pagination over version history', async () => {
    const txHashes = [
      '0x' + '10'.repeat(32),
      '0x' + '20'.repeat(32),
      '0x' + '30'.repeat(32),
    ];
    for (let i = 0; i < 3; i++) {
      await seedEvent({
        eventName: i === 0 ? 'EvidenceRegistered' : 'EvidenceReplaced',
        txHash: txHashes[i],
        blockNumber: String(100 + i * 10),
        logIndex: 0,
        payload: { digest: `0xdigest${i}` },
      });
    }
    await projector.processNewEvents();

    const evidence = await queryService.getEvidence(claimId);
    const firstPage = await queryService.listVersions(
      evidence.evidenceId,
      undefined,
      2,
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await queryService.listVersions(
      evidence.evidenceId,
      firstPage.nextCursor!,
      2,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
  });
});
