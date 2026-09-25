import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Interface, AbiCoder } from 'ethers';
import { ReorgRollbackService } from './reorg-rollback.service';
import { CanonicalEventsService } from './canonical-events.service';
import { CanonicalEventQueryService } from './canonical-event-query.service';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { EvidenceProjectorService } from '../evidence/evidence-projector.service';
import { EvidenceQueryService } from '../evidence/evidence-query.service';
import { VerificationProjectorService } from '../verification/verification-projector.service';
import { VerificationQueryService } from '../verification/verification-query.service';
import { DisputesProjectorService } from '../disputes/disputes-projector.service';
import { DisputesQueryService } from '../disputes/disputes-query.service';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { ContractArtifact } from './entities/contract-artifact.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import {
  EventQuarantine,
  QuarantineReason,
} from './entities/event-quarantine.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import {
  ProjectEvidence,
  EvidenceStatus,
} from '../evidence/entities/project-evidence.entity';
import { ProjectEvidenceVersion } from '../evidence/entities/project-evidence-version.entity';
import {
  ProjectVerificationRound,
  RoundType,
  RoundStatus,
} from '../verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../verification/entities/project-participant-position.entity';
import {
  ProjectDispute,
  DisputeStatus,
} from '../disputes/entities/project-dispute.entity';
import { RawLog } from './interfaces/canonical-event.interface';

describe('ReorgRollbackService (integration)', () => {
  let moduleRef: TestingModule;
  let reorgService: ReorgRollbackService;
  let canonicalEventsService: CanonicalEventsService;
  let evidenceProjector: EvidenceProjectorService;
  let verificationProjector: VerificationProjectorService;
  let disputesProjector: DisputesProjectorService;
  let dataSource: DataSource;

  let canonicalRepo: Repository<CanonicalEvent>;
  let checkpointRepo: Repository<EventCheckpoint>;
  let cursorRepo: Repository<ProjectorCursor>;
  let evidenceRepo: Repository<ProjectEvidence>;
  let versionRepo: Repository<ProjectEvidenceVersion>;
  let roundRepo: Repository<ProjectVerificationRound>;
  let positionRepo: Repository<ProjectParticipantPosition>;
  let disputeRepo: Repository<ProjectDispute>;
  let anomalyRepo: Repository<IndexingAnomaly>;
  let quarantineRepo: Repository<EventQuarantine>;
  let artifactRepo: Repository<ContractArtifact>;

  const chainId = 10;
  const contractAddress = '0x' + '11'.repeat(20);
  const claimId = '0x' + '22'.repeat(32);
  const roundId = '0x' + '33'.repeat(32);
  const actor = '0x' + '44'.repeat(20);

  const abi = [
    'event EvidenceRegistered(bytes32 indexed claimId, address indexed submitter, bytes32 digest)',
    'event EvidenceReplaced(bytes32 indexed claimId, address indexed submitter, bytes32 digest)',
    'event VerificationRoundOpened(bytes32 indexed claimId, bytes32 indexed roundId, uint8 roundType, uint32 roundNumber, uint256 deadline)',
    'event PositionCommitted(bytes32 indexed roundId, address indexed participant, uint256 stake, uint256 reputationInput, uint256 effectiveWeight, bytes32 verdict)',
    'event DisputeRaised(bytes32 indexed claimId, bytes32 indexed originalRoundId, bytes32 appealRoundId, address challenger, uint256 challengeBond, address bondAsset, uint256 deadline)',
    'event DisputeResolved(bytes32 indexed claimId, bytes32 indexed originalRoundId, bytes32 outcome)',
  ];
  const iface = new Interface(abi);

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
            ContractArtifact,
            EventCheckpoint,
            EventQuarantine,
            ProjectorCursor,
            IndexingAnomaly,
            ProjectEvidence,
            ProjectEvidenceVersion,
            ProjectVerificationRound,
            ProjectParticipantPosition,
            ProjectDispute,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          CanonicalEvent,
          ContractArtifact,
          EventCheckpoint,
          EventQuarantine,
          ProjectorCursor,
          IndexingAnomaly,
          ProjectEvidence,
          ProjectEvidenceVersion,
          ProjectVerificationRound,
          ProjectParticipantPosition,
          ProjectDispute,
        ]),
      ],
      providers: [
        ArtifactRegistryService,
        EventDecoderService,
        CanonicalEventsService,
        CanonicalEventQueryService,
        ReorgRollbackService,
        EvidenceProjectorService,
        EvidenceQueryService,
        VerificationProjectorService,
        VerificationQueryService,
        DisputesProjectorService,
        DisputesQueryService,
      ],
    }).compile();

    reorgService = moduleRef.get(ReorgRollbackService);
    canonicalEventsService = moduleRef.get(CanonicalEventsService);
    evidenceProjector = moduleRef.get(EvidenceProjectorService);
    verificationProjector = moduleRef.get(VerificationProjectorService);
    disputesProjector = moduleRef.get(DisputesProjectorService);
    dataSource = moduleRef.get(DataSource);

    canonicalRepo = dataSource.getRepository(CanonicalEvent);
    checkpointRepo = dataSource.getRepository(EventCheckpoint);
    cursorRepo = dataSource.getRepository(ProjectorCursor);
    evidenceRepo = dataSource.getRepository(ProjectEvidence);
    versionRepo = dataSource.getRepository(ProjectEvidenceVersion);
    roundRepo = dataSource.getRepository(ProjectVerificationRound);
    positionRepo = dataSource.getRepository(ProjectParticipantPosition);
    disputeRepo = dataSource.getRepository(ProjectDispute);
    anomalyRepo = dataSource.getRepository(IndexingAnomaly);
    quarantineRepo = dataSource.getRepository(EventQuarantine);
    artifactRepo = dataSource.getRepository(ContractArtifact);

    // Register approved artifact
    await artifactRepo.insert({
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      artifactVersion: 'v1.0.0',
      abi,
      isApproved: true,
    });
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  function makeLog(
    eventName: string,
    args: any[],
    blockNumber: bigint,
    logIndex: number,
    txHash: string,
  ): RawLog {
    const fragment = iface.getEvent(eventName)!;
    const topics = iface.encodeFilterTopics(
      fragment,
      args.slice(0, fragment.inputs.filter((i) => i.indexed).length),
    ) as string[];
    const nonIndexedInputs = fragment.inputs.filter((i) => !i.indexed);
    const nonIndexedArgs = args.slice(
      fragment.inputs.filter((i) => i.indexed).length,
    );
    const data =
      nonIndexedInputs.length > 0
        ? AbiCoder.defaultAbiCoder().encode(
            nonIndexedInputs.map((i) => i.type),
            nonIndexedArgs,
          )
        : '0x';

    return {
      chainId,
      address: contractAddress,
      topics,
      data,
      transactionHash: txHash,
      logIndex,
      blockNumber,
      blockTimestamp: new Date(),
    };
  }

  it('rolls back orphaned canonical events and rewinds cursors and checkpoints', async () => {
    // 1. Ingest block 100 event
    const log1 = makeLog(
      'EvidenceRegistered',
      [claimId, actor, '0x' + 'aa'.repeat(32)],
      100n,
      0,
      '0x' + '01'.repeat(32),
    );
    await canonicalEventsService.ingest(log1);

    // 2. Ingest block 200 event (to be reorged)
    const log2 = makeLog(
      'EvidenceReplaced',
      [claimId, actor, '0x' + 'bb'.repeat(32)],
      200n,
      0,
      '0x' + '02'.repeat(32),
    );
    await canonicalEventsService.ingest(log2);

    // Run projector
    await evidenceProjector.processNewEvents();

    let evidence = await evidenceRepo.findOne({
      where: { evidenceId: claimId },
    });
    expect(evidence?.currentVersion).toBe(2);
    expect(evidence?.contentDigest).toBe('0x' + 'bb'.repeat(32));

    const checkpointBefore = await checkpointRepo.findOne({
      where: { chainId, contractAddress },
    });
    expect(checkpointBefore?.lastSafeBlock).toBe('200');

    // 3. Roll back to block 100
    const result = await reorgService.rollback(chainId, 100n);

    expect(result.purgedEventsCount).toBe(1);
    expect(result.checkpointsUpdated).toBe(1);
    expect(result.rewoundCursors).toContain('v2-evidence');
    expect(result.affectedReadModels.evidenceVersionsRemoved).toBe(1);
    expect(result.affectedReadModels.evidenceUpdated).toBe(1);

    // Verify canonical events table
    const remainingEvents = await canonicalRepo.find();
    expect(remainingEvents).toHaveLength(1);
    expect(remainingEvents[0].blockNumber).toBe('100');

    // Verify checkpoint was updated to 100
    const checkpointAfter = await checkpointRepo.findOne({
      where: { chainId, contractAddress },
    });
    expect(checkpointAfter?.lastSafeBlock).toBe('100');

    // Verify projector cursor was rewound to 100
    const cursor = await cursorRepo.findOne({
      where: { projectorName: 'v2-evidence' },
    });
    expect(cursor?.lastBlockNumber).toBe('100');

    // Verify evidence read model reverted to version 1
    evidence = await evidenceRepo.findOne({ where: { evidenceId: claimId } });
    expect(evidence?.currentVersion).toBe(1);
    expect(evidence?.contentDigest).toBe('0x' + 'aa'.repeat(32));
    expect(evidence?.lastEventBlockNumber).toBe('100');
  });

  it('deletes evidence record completely when all versions are in rolled back blocks', async () => {
    const log = makeLog(
      'EvidenceRegistered',
      [claimId, actor, '0x' + 'aa'.repeat(32)],
      150n,
      0,
      '0x' + '01'.repeat(32),
    );
    await canonicalEventsService.ingest(log);
    await evidenceProjector.processNewEvents();

    expect(await evidenceRepo.count()).toBe(1);
    expect(await versionRepo.count()).toBe(1);

    // Rollback to block 100 (before evidence was registered)
    const result = await reorgService.rollback(chainId, 100n);
    expect(result.affectedReadModels.evidenceRemoved).toBe(1);
    expect(result.affectedReadModels.evidenceVersionsRemoved).toBe(1);

    expect(await evidenceRepo.count()).toBe(0);
    expect(await versionRepo.count()).toBe(0);
  });

  it('rolls back verification rounds and participant positions', async () => {
    // Block 100: Round opened
    const logRound = makeLog(
      'VerificationRoundOpened',
      [claimId, roundId, 0, 1, 1700000000],
      100n,
      0,
      '0x' + '10'.repeat(32),
    );
    await canonicalEventsService.ingest(logRound);

    // Block 200: Position committed (to be rolled back)
    const logPos = makeLog(
      'PositionCommitted',
      [
        roundId,
        actor,
        1000,
        50,
        1000,
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ],
      200n,
      0,
      '0x' + '20'.repeat(32),
    );
    await canonicalEventsService.ingest(logPos);

    await verificationProjector.processNewEvents();

    expect(await roundRepo.count()).toBe(1);
    expect(await positionRepo.count()).toBe(1);

    // Roll back block 200
    const result = await reorgService.rollback(chainId, 100n);
    expect(result.affectedReadModels.participantPositionsRemoved).toBe(1);
    expect(result.affectedReadModels.verificationRoundsRemoved).toBe(0);

    expect(await roundRepo.count()).toBe(1);
    expect(await positionRepo.count()).toBe(0);

    // Now roll back block 100 as well
    const result2 = await reorgService.rollback(chainId, 50n);
    expect(result2.affectedReadModels.verificationRoundsRemoved).toBe(1);
    expect(await roundRepo.count()).toBe(0);
  });

  it('reverts resolved dispute back to RAISED when DisputeResolved is rolled back', async () => {
    // Block 100: Dispute raised
    const logRaised = makeLog(
      'DisputeRaised',
      [
        claimId,
        roundId,
        '0x' + '55'.repeat(32),
        actor,
        5000,
        '0x' + '66'.repeat(20),
        1800000000,
      ],
      100n,
      0,
      '0x' + '10'.repeat(32),
    );
    await canonicalEventsService.ingest(logRaised);

    // Block 200: Dispute resolved (to be rolled back)
    const logResolved = makeLog(
      'DisputeResolved',
      [claimId, roundId, '0x' + '77'.repeat(32)],
      200n,
      0,
      '0x' + '20'.repeat(32),
    );
    await canonicalEventsService.ingest(logResolved);

    await disputesProjector.processNewEvents();

    const disputeId = `${claimId}:${roundId}`;
    let dispute = await disputeRepo.findOne({ where: { disputeId } });
    expect(dispute?.status).toBe(DisputeStatus.RESOLVED);
    expect(dispute?.eventTxHash).toBe('0x' + '20'.repeat(32));

    // Roll back block 200
    const result = await reorgService.rollback(chainId, 100n);
    expect(result.affectedReadModels.disputesReverted).toBe(1);
    expect(result.affectedReadModels.disputesRemoved).toBe(0);

    dispute = await disputeRepo.findOne({ where: { disputeId } });
    expect(dispute?.status).toBe(DisputeStatus.RAISED);
    expect(dispute?.resolvedOutcome).toBeNull();
    expect(dispute?.eventTxHash).toBe('0x' + '10'.repeat(32));
  });

  it('deletes dispute completely when DisputeRaised is rolled back', async () => {
    const logRaised = makeLog(
      'DisputeRaised',
      [
        claimId,
        roundId,
        '0x' + '55'.repeat(32),
        actor,
        5000,
        '0x' + '66'.repeat(20),
        1800000000,
      ],
      150n,
      0,
      '0x' + '10'.repeat(32),
    );
    await canonicalEventsService.ingest(logRaised);
    await disputesProjector.processNewEvents();

    expect(await disputeRepo.count()).toBe(1);

    const result = await reorgService.rollback(chainId, 100n);
    expect(result.affectedReadModels.disputesRemoved).toBe(1);
    expect(await disputeRepo.count()).toBe(0);
  });

  it('purges quarantined events and anomalies from rolled-back blocks', async () => {
    // Insert a quarantine event at block 200
    await quarantineRepo.insert({
      chainId,
      contractAddress,
      txHash: '0x' + '99'.repeat(32),
      logIndex: 0,
      blockNumber: '200',
      topic0: '0x' + 'aa'.repeat(32),
      reason: QuarantineReason.UNKNOWN_SIGNATURE,
      rawLog: { topics: [], data: '0x' },
      detail: 'test',
    });

    // Insert an anomaly tied to an orphaned block 200 tx
    await anomalyRepo.insert({
      sourceModule: 'v2-disputes',
      kind: IndexingAnomalyKind.INVALID_TRANSITION,
      aggregateId: 'test-agg',
      eventTxHash: '0x' + '99'.repeat(32),
      eventLogIndex: 0,
      detail: 'test anomaly',
    });

    // Also a canonical event at block 200
    const log = makeLog(
      'EvidenceRegistered',
      [claimId, actor, '0x' + 'aa'.repeat(32)],
      200n,
      0,
      '0x' + '99'.repeat(32),
    );
    await canonicalEventsService.ingest(log);

    expect(await quarantineRepo.count()).toBe(1);
    expect(await anomalyRepo.count()).toBe(1);

    await reorgService.rollback(chainId, 100n);

    expect(await quarantineRepo.count()).toBe(0);
    expect(await anomalyRepo.count()).toBe(0);
  });

  it('coordinates full reorg rollback and canonical reapplication cycle', async () => {
    // 1. Initial chain state: block 100 (valid), block 200 (orphaned fork)
    const logInitial = makeLog(
      'EvidenceRegistered',
      [claimId, actor, '0x' + '11'.repeat(32)],
      100n,
      0,
      '0x' + '01'.repeat(32),
    );
    const logOrphaned = makeLog(
      'EvidenceReplaced',
      [claimId, actor, '0x' + '22'.repeat(32)],
      200n,
      0,
      '0x' + '02'.repeat(32),
    );

    await canonicalEventsService.ingest(logInitial);
    await canonicalEventsService.ingest(logOrphaned);
    await evidenceProjector.processNewEvents();

    let evidence = await evidenceRepo.findOne({
      where: { evidenceId: claimId },
    });
    expect(evidence?.contentDigest).toBe('0x' + '22'.repeat(32));

    // 2. New winning fork logs for block 200 and block 201
    const newLogFork1 = makeLog(
      'EvidenceReplaced',
      [claimId, actor, '0x' + '88'.repeat(32)],
      200n,
      0,
      '0x' + '88'.repeat(32),
    );
    const newLogFork2 = makeLog(
      'EvidenceReplaced',
      [claimId, actor, '0x' + '99'.repeat(32)],
      201n,
      0,
      '0x' + '99'.repeat(32),
    );

    const reorgResult = await reorgService.handleReorg({
      chainId,
      rollbackToBlock: 100n,
      newLogs: [newLogFork2, newLogFork1], // intentionally unsorted to verify deterministic reapplication
    });

    expect(reorgResult.rollback.purgedEventsCount).toBe(1);
    expect(reorgResult.reapplication.logsProcessed).toBe(2);
    expect(reorgResult.reapplication.ingestedCount).toBe(2);

    // Verify read model reflects winning fork state
    evidence = await evidenceRepo.findOne({ where: { evidenceId: claimId } });
    expect(evidence?.currentVersion).toBe(3); // v1(block 100) -> v2(block 200 new) -> v3(block 201 new)
    expect(evidence?.contentDigest).toBe('0x' + '99'.repeat(32));
    expect(evidence?.lastEventBlockNumber).toBe('201');

    const versions = await versionRepo.find({
      where: { evidenceId: claimId },
      order: { version: 'ASC' },
    });
    expect(versions.map((v) => v.contentDigest)).toEqual([
      '0x' + '11'.repeat(32),
      '0x' + '88'.repeat(32),
      '0x' + '99'.repeat(32),
    ]);
  });

  it('rebuildAllProjections resets cursors and reconstructs projections from genesis', async () => {
    // Ingest events
    const log1 = makeLog(
      'EvidenceRegistered',
      [claimId, actor, '0x' + '11'.repeat(32)],
      100n,
      0,
      '0x' + '01'.repeat(32),
    );
    const log2 = makeLog(
      'EvidenceReplaced',
      [claimId, actor, '0x' + '22'.repeat(32)],
      200n,
      0,
      '0x' + '02'.repeat(32),
    );
    await canonicalEventsService.ingest(log1);
    await canonicalEventsService.ingest(log2);
    await evidenceProjector.processNewEvents();

    expect(await versionRepo.count()).toBe(2);

    // Trigger full rebuild
    const rebuildSummary = await reorgService.rebuildAllProjections();
    expect(rebuildSummary['v2-evidence'].applied).toBe(2);

    const evidence = await evidenceRepo.findOne({
      where: { evidenceId: claimId },
    });
    expect(evidence?.currentVersion).toBe(2);
    expect(evidence?.contentDigest).toBe('0x' + '22'.repeat(32));
  });
});
