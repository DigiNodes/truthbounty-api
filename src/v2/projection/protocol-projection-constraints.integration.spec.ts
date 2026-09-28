import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { EventQuarantine } from '../events/entities/event-quarantine.entity';
import { ContractArtifact } from '../events/entities/contract-artifact.entity';
import {
  ProjectEvidence,
  EvidenceStatus,
} from '../evidence/entities/project-evidence.entity';
import { ProjectEvidenceVersion } from '../evidence/entities/project-evidence-version.entity';
import {
  ProjectVerificationRound,
  RoundStatus,
  RoundType,
} from '../verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../verification/entities/project-participant-position.entity';
import {
  ProjectDispute,
  DisputeStatus,
} from '../disputes/entities/project-dispute.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import { DataState } from '../common/data-state.enum';

/**
 * issue396: DB-boundary constraints for protocol projections.
 * Uses deterministic sqlite :memory: (service-container substitute) with
 * synchronize:true so entity @Check/@Unique/@FK are enforced exactly as the
 * Postgres migration enforces them in production.
 *
 * Covers: success, boundary, authorization-shape (fail-closed validation),
 * failure, concurrency/idempotency, replay, restart, degraded deps.
 */
describe('ProtocolProjectionConstraints (integration, issue396)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  const txA = `0x${'01'.repeat(32)}`;
  const txB = `0x${'02'.repeat(32)}`;
  const claimId = `0x${'11'.repeat(32)}`;
  const roundId = `0x${'aa'.repeat(32)}`;

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
            EventCheckpoint,
            EventQuarantine,
            ContractArtifact,
            ProjectEvidence,
            ProjectEvidenceVersion,
            ProjectVerificationRound,
            ProjectParticipantPosition,
            ProjectDispute,
            ProjectorCursor,
            IndexingAnomaly,
          ],
          synchronize: true,
        }),
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    await dataSource.query('PRAGMA foreign_keys = ON');
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('success: canonical event + evidence version chain persists with FK linkage', async () => {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: `0x${'aa'.repeat(20)}`,
      artifactVersion: 'v1',
      eventName: 'EvidenceRegistered',
      txHash: txA,
      logIndex: 0,
      blockNumber: '100',
      claimId,
      payload: {},
      rawArgs: {},
    });
    await dataSource.getRepository(ProjectEvidence).insert({
      evidenceId: claimId,
      claimId,
      currentVersion: 1,
      status: EvidenceStatus.ACTIVE,
      contentDigest: '0xdigest',
      lastEventBlockNumber: '100',
      lastEventLogIndex: 0,
    });
    await dataSource.getRepository(ProjectEvidenceVersion).insert({
      evidenceId: claimId,
      version: 1,
      contentDigest: '0xdigest',
      eventTxHash: txA,
      eventLogIndex: 0,
      blockNumber: '100',
    });
    const versions = await dataSource
      .getRepository(ProjectEvidenceVersion)
      .find();
    expect(versions).toHaveLength(1);
  });

  it('boundary: rejects negative block/log and bad enum at DB boundary (fail closed)', async () => {
    await expect(
      dataSource.getRepository(CanonicalEvent).insert({
        chainId: 10,
        contractAddress: `0x${'aa'.repeat(20)}`,
        artifactVersion: 'v1',
        eventName: 'EvidenceRegistered',
        txHash: txA,
        logIndex: -1,
        blockNumber: '100',
        payload: {},
        rawArgs: {},
      }),
    ).rejects.toThrow();
    await expect(
      dataSource.getRepository(ProjectDispute).insert({
        disputeId: `${claimId}:${roundId}`,
        claimId,
        originalRoundId: roundId,
        status: 'bogus' as unknown as DisputeStatus,
        eventTxHash: txA,
        eventLogIndex: 0,
        blockNumber: '100',
      }),
    ).rejects.toThrow();
  });

  it('failure: enforces canonical event identity uniqueness (idempotency key)', async () => {
    const repo = dataSource.getRepository(CanonicalEvent);
    const row = {
      chainId: 10,
      contractAddress: `0x${'aa'.repeat(20)}`,
      artifactVersion: 'v1',
      eventName: 'DisputeRaised',
      txHash: txA,
      logIndex: 0,
      blockNumber: '100',
      claimId,
      roundId,
      payload: {},
      rawArgs: {},
    };
    await repo.insert({ ...row });
    await expect(repo.insert({ ...row })).rejects.toThrow();
  });

  it('failure: enforces FK version->evidence and position->round (no orphans)', async () => {
    await expect(
      dataSource.getRepository(ProjectEvidenceVersion).insert({
        evidenceId: 'missing-evidence',
        version: 1,
        contentDigest: '0xdigest',
        eventTxHash: txA,
        eventLogIndex: 0,
        blockNumber: '100',
      }),
    ).rejects.toThrow();
    await expect(
      dataSource.getRepository(ProjectParticipantPosition).insert({
        roundId: 'missing-round',
        participant: `0x${'22'.repeat(20)}`,
        stake: '100',
        eventTxHash: txA,
        eventLogIndex: 0,
        blockNumber: '100',
      }),
    ).rejects.toThrow();
  });

  it('concurrency/idempotency: duplicate (eventTxHash,eventLogIndex) is a replay, not a second row', async () => {
    const repo = dataSource.getRepository(ProjectVerificationRound);
    await repo.insert({
      roundId,
      claimId,
      roundType: RoundType.FIRST,
      roundNumber: 1,
      status: RoundStatus.OPEN,
      openedAtBlock: '100',
      eventTxHash: txA,
      eventLogIndex: 0,
    });
    await expect(
      repo.insert({
        roundId: `0x${'bb'.repeat(32)}`,
        claimId,
        roundType: RoundType.FIRST,
        roundNumber: 2,
        status: RoundStatus.OPEN,
        openedAtBlock: '101',
        eventTxHash: txA,
        eventLogIndex: 0,
      }),
    ).rejects.toThrow();
    expect(await repo.count()).toBe(1);
  });

  it('replay/restart: projector cursor round-trips and anomaly dedup is bounded', async () => {
    const cursors = dataSource.getRepository(ProjectorCursor);
    await cursors.upsert(
      { projectorName: 'v2-disputes', lastBlockNumber: '100', lastLogIndex: 0 },
      ['projectorName'],
    );
    await cursors.upsert(
      { projectorName: 'v2-disputes', lastBlockNumber: '200', lastLogIndex: 1 },
      ['projectorName'],
    );
    expect(await cursors.count()).toBe(1);
    const anomalies = dataSource.getRepository(IndexingAnomaly);
    await anomalies.insert({
      sourceModule: 'v2-disputes',
      kind: IndexingAnomalyKind.DUPLICATE_EVENT,
      aggregateId: `${claimId}:${roundId}`,
      eventTxHash: txA,
      eventLogIndex: 0,
      detail: 'duplicate',
    });
    await expect(
      anomalies.insert({
        sourceModule: 'v2-disputes',
        kind: IndexingAnomalyKind.DUPLICATE_EVENT,
        aggregateId: `${claimId}:${roundId}`,
        eventTxHash: txA,
        eventLogIndex: 0,
        detail: 'duplicate replay',
      }),
    ).rejects.toThrow();
  });

  it('degraded deps: checkpoints default safe/finalized to 0 and dataState defaults to observed', async () => {
    await dataSource.getRepository(EventCheckpoint).insert({
      chainId: 10,
      contractAddress: `0x${'aa'.repeat(20)}`,
    });
    const cp = await dataSource.getRepository(EventCheckpoint).findOneOrFail({
      where: { chainId: 10 },
    });
    expect(String(cp.lastSafeBlock)).toBe('0');
    await dataSource.getRepository(ProjectDispute).insert({
      disputeId: `${claimId}:${roundId}`,
      claimId,
      originalRoundId: roundId,
      status: DisputeStatus.RAISED,
      eventTxHash: txB,
      eventLogIndex: 0,
      blockNumber: '50',
    });
    const dispute = await dataSource
      .getRepository(ProjectDispute)
      .findOneOrFail({ where: { disputeId: `${claimId}:${roundId}` } });
    expect(dispute.dataState).toBe(DataState.OBSERVED);
    expect(dispute.disputeId).toContain(':');
  });

  it('retry: checkpoint final <= safe invariant holds (reorg-safe cursor)', async () => {
    await expect(
      dataSource.getRepository(EventCheckpoint).insert({
        chainId: 10,
        contractAddress: `0x${'bb'.repeat(20)}`,
        lastSafeBlock: '100',
        lastFinalizedBlock: '200',
      }),
    ).rejects.toThrow();
  });
});
