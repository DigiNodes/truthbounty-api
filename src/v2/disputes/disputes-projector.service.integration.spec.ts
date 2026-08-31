import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DisputesProjectorService } from './disputes-projector.service';
import { DisputesQueryService } from './disputes-query.service';
import {
  ProjectDispute,
  DisputeStatus,
} from './entities/project-dispute.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';

describe('DisputesProjectorService (integration)', () => {
  let moduleRef: TestingModule;
  let projector: DisputesProjectorService;
  let queryService: DisputesQueryService;
  let dataSource: DataSource;

  const claimId = '0x' + '11'.repeat(32);
  const roundId = '0x' + 'aa'.repeat(32);

  async function seedEvent(overrides: Partial<CanonicalEvent>): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: '0x' + 'aa'.repeat(20),
      artifactVersion: 'v1',
      txHash: '0x' + '00'.repeat(32),
      logIndex: 0,
      blockNumber: '1',
      claimId,
      roundId,
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
            ProjectDispute,
            ProjectorCursor,
            IndexingAnomaly,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          ProjectDispute,
          ProjectorCursor,
          IndexingAnomaly,
          CanonicalEvent,
        ]),
      ],
      providers: [
        DisputesProjectorService,
        DisputesQueryService,
        CanonicalEventQueryService,
      ],
    }).compile();

    projector = moduleRef.get(DisputesProjectorService);
    queryService = moduleRef.get(DisputesQueryService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('projects DisputeRaised, linking deterministically to the claim and original round', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      actor: '0x' + '22'.repeat(20),
      asset: '0x' + '33'.repeat(20),
      amount: '5000',
      payload: { deadline: '200000000' },
    });

    await projector.processNewEvents();

    const dispute = await queryService.getByOriginalRound(claimId, roundId);
    expect(dispute.status).toBe(DisputeStatus.RAISED);
    expect(dispute.claimId).toBe(claimId);
    expect(dispute.originalRoundId).toBe(roundId);
    expect(dispute.challengeBond).toBe('5000');
  });

  it('DisputeResolved transitions RAISED -> RESOLVED and stores the verbatim outcome', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });
    await seedEvent({
      eventName: 'DisputeResolved',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '200',
      payload: { outcome: 'upheld' },
    });

    await projector.processNewEvents();

    const dispute = await queryService.getByOriginalRound(claimId, roundId);
    expect(dispute.status).toBe(DisputeStatus.RESOLVED);
    expect(dispute.resolvedOutcome).toBe('upheld');
  });

  it('DisputeExpired transitions RAISED -> EXPIRED', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });
    await seedEvent({
      eventName: 'DisputeExpired',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '200',
    });

    await projector.processNewEvents();

    const dispute = await queryService.getByOriginalRound(claimId, roundId);
    expect(dispute.status).toBe(DisputeStatus.EXPIRED);
  });

  it('rejects DisputeResolved for a dispute that was never raised, recording an invalid-transition anomaly', async () => {
    await seedEvent({
      eventName: 'DisputeResolved',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });

    const summary = await projector.processNewEvents();
    expect(summary.anomalies).toBe(1);

    const disputes = await dataSource.getRepository(ProjectDispute).find();
    expect(disputes).toHaveLength(0);

    const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
    expect(anomalies[0].kind).toBe(IndexingAnomalyKind.INVALID_TRANSITION);
  });

  it('rejects a second terminal transition on an already-resolved dispute (RESOLVED -> EXPIRED)', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });
    await seedEvent({
      eventName: 'DisputeResolved',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '200',
      payload: { outcome: 'upheld' },
    });
    await seedEvent({
      eventName: 'DisputeExpired',
      txHash: '0x' + '03'.repeat(32),
      blockNumber: '300',
    });

    const summary = await projector.processNewEvents();
    expect(summary.anomalies).toBe(1);

    const dispute = await queryService.getByOriginalRound(claimId, roundId);
    expect(dispute.status).toBe(DisputeStatus.RESOLVED); // unchanged by the rejected transition

    const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
    expect(anomalies[0].kind).toBe(IndexingAnomalyKind.INVALID_TRANSITION);
  });

  it('detects a second DisputeRaised for the same claim/round as a duplicate anomaly, not a second row', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '110',
    });

    const summary = await projector.processNewEvents();
    expect(summary.anomalies).toBe(1);

    const disputes = await dataSource.getRepository(ProjectDispute).find();
    expect(disputes).toHaveLength(1);

    const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
    expect(anomalies[0].kind).toBe(IndexingAnomalyKind.DUPLICATE_EVENT);
  });

  it('is replay-safe: reprocessing already-applied events does not duplicate state or anomalies', async () => {
    await seedEvent({
      eventName: 'DisputeRaised',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
    });
    await seedEvent({
      eventName: 'DisputeResolved',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '200',
      payload: { outcome: 'upheld' },
    });

    await projector.processNewEvents();
    const secondRun = await projector.processNewEvents();
    expect(secondRun.processed).toBe(0);

    const disputes = await dataSource.getRepository(ProjectDispute).find();
    expect(disputes).toHaveLength(1);
    expect(disputes[0].status).toBe(DisputeStatus.RESOLVED);
  });
});
