import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VerificationProjectorService } from './verification-projector.service';
import { VerificationQueryService } from './verification-query.service';
import {
  ProjectVerificationRound,
  RoundStatus,
} from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';

describe('VerificationProjectorService (integration)', () => {
  let moduleRef: TestingModule;
  let projector: VerificationProjectorService;
  let queryService: VerificationQueryService;
  let dataSource: DataSource;

  const claimId = '0x' + '11'.repeat(32);
  const firstRoundId = '0x' + 'aa'.repeat(32);
  const appealRoundId = '0x' + 'bb'.repeat(32);

  async function seedEvent(overrides: Partial<CanonicalEvent>): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: '0x' + 'aa'.repeat(20),
      artifactVersion: 'v1',
      txHash: '0x' + '00'.repeat(32),
      logIndex: 0,
      blockNumber: '1',
      claimId,
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
            ProjectVerificationRound,
            ProjectParticipantPosition,
            ProjectorCursor,
            IndexingAnomaly,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          ProjectVerificationRound,
          ProjectParticipantPosition,
          ProjectorCursor,
          IndexingAnomaly,
          CanonicalEvent,
        ]),
      ],
      providers: [
        VerificationProjectorService,
        VerificationQueryService,
        CanonicalEventQueryService,
      ],
    }).compile();

    projector = moduleRef.get(VerificationProjectorService);
    queryService = moduleRef.get(VerificationQueryService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('projects a first round and an appeal round as isolated records', async () => {
    await seedEvent({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      roundId: firstRoundId,
      payload: { roundType: 'first', roundNumber: '1' },
    });
    await seedEvent({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + '02'.repeat(32),
      blockNumber: '200',
      roundId: appealRoundId,
      payload: { roundType: 'appeal', roundNumber: '1' },
    });

    await projector.processNewEvents();

    const { first, appeal } = await queryService.listRounds(claimId);
    expect(first).toHaveLength(1);
    expect(appeal).toHaveLength(1);
    expect(first[0].roundId).toBe(firstRoundId);
    expect(appeal[0].roundId).toBe(appealRoundId);
    expect(first[0].status).toBe(RoundStatus.OPEN);
  });

  it('projects a participant position with stake/reputation/weight verbatim, never recomputed', async () => {
    await seedEvent({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      roundId: firstRoundId,
      payload: { roundType: 'first', roundNumber: '1' },
    });
    await seedEvent({
      eventName: 'PositionCommitted',
      txHash: '0x' + '03'.repeat(32),
      blockNumber: '110',
      roundId: firstRoundId,
      actor: '0x' + '22'.repeat(20),
      payload: {
        stake: '1000000000000000000',
        reputationInput: '750',
        effectiveWeight: '850',
        verdict: 'support',
      },
    });

    await projector.processNewEvents();

    const positions = await queryService.listPositions(firstRoundId);
    expect(positions).toHaveLength(1);
    expect(positions[0].stake).toBe('1000000000000000000');
    expect(positions[0].effectiveWeight).toBe('850');
    expect(positions[0].position).toBe('support');
  });

  it('detects and records a duplicate position for the same participant/round instead of overwriting it', async () => {
    await seedEvent({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      roundId: firstRoundId,
      payload: { roundType: 'first', roundNumber: '1' },
    });
    await seedEvent({
      eventName: 'PositionCommitted',
      txHash: '0x' + '03'.repeat(32),
      blockNumber: '110',
      roundId: firstRoundId,
      actor: '0x' + '22'.repeat(20),
      payload: { stake: '100', verdict: 'support' },
    });
    await seedEvent({
      eventName: 'PositionCommitted',
      txHash: '0x' + '04'.repeat(32), // different event, same participant/round
      blockNumber: '111',
      roundId: firstRoundId,
      actor: '0x' + '22'.repeat(20),
      payload: { stake: '999', verdict: 'oppose' },
    });

    const summary = await projector.processNewEvents();
    expect(summary.anomalies).toBe(1);

    const positions = await queryService.listPositions(firstRoundId);
    expect(positions).toHaveLength(1);
    expect(positions[0].stake).toBe('100'); // first-committed position wins, not overwritten

    const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe(IndexingAnomalyKind.DUPLICATE_EVENT);
  });

  it('detects an out-of-order PositionCommitted whose round has not been projected yet', async () => {
    await seedEvent({
      eventName: 'PositionCommitted',
      txHash: '0x' + '03'.repeat(32),
      blockNumber: '110',
      roundId: '0x' + 'ff'.repeat(32), // no matching VerificationRoundOpened seeded
      actor: '0x' + '22'.repeat(20),
      payload: { stake: '100' },
    });

    const summary = await projector.processNewEvents();
    expect(summary.anomalies).toBe(1);

    const positions = await dataSource
      .getRepository(ProjectParticipantPosition)
      .find();
    expect(positions).toHaveLength(0);

    const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
    expect(anomalies[0].kind).toBe(IndexingAnomalyKind.OUT_OF_ORDER);
  });

  it('is replay-safe: reprocessing already-applied events does not duplicate rounds or positions', async () => {
    await seedEvent({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + '01'.repeat(32),
      blockNumber: '100',
      roundId: firstRoundId,
      payload: { roundType: 'first', roundNumber: '1' },
    });

    await projector.processNewEvents();
    const secondRun = await projector.processNewEvents();
    expect(secondRun.processed).toBe(0);

    const rounds = await dataSource
      .getRepository(ProjectVerificationRound)
      .find();
    expect(rounds).toHaveLength(1);
  });
});
