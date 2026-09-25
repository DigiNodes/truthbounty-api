import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProjectionRebuildService } from './projection-rebuild.service';
import { PROJECTION_REGISTRY, RebuildableProjection, buildDefaultRegistry } from './projection-registry';
import { ProjectionRebuildRun } from './entities/projection-rebuild-run.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { IndexingAnomaly } from '../common/entities/indexing-anomaly.entity';
import { ProjectEvidence } from '../evidence/entities/project-evidence.entity';
import { ProjectEvidenceVersion } from '../evidence/entities/project-evidence-version.entity';
import { EvidenceProjectorService } from '../evidence/evidence-projector.service';
import { ProjectVerificationRound } from '../verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../verification/entities/project-participant-position.entity';
import { VerificationProjectorService } from '../verification/verification-projector.service';
import { ProjectDispute } from '../disputes/entities/project-dispute.entity';
import { DisputesProjectorService } from '../disputes/disputes-projector.service';
import { ProjectRewardAllocation } from '../rewards/entities/project-reward-allocation.entity';
import { ProjectRewardPool } from '../rewards/entities/project-reward-pool.entity';
import { ProjectRewardClaim } from '../rewards/entities/project-reward-claim.entity';
import { RewardsProjectorService } from '../rewards/rewards-projector.service';

const CLAIM_ID = '0x' + '11'.repeat(32);
const ROUND_ID = '0x' + 'aa'.repeat(32);
const ASSET = '0x' + '33'.repeat(20);
const ACTOR = '0x' + '22'.repeat(20);

const DEPLOYMENT_BLOCK = '1000';

describe('ProjectionRebuildService (integration)', () => {
  let moduleRef: TestingModule;
  let service: ProjectionRebuildService;
  let dataSource: DataSource;
  const originalSchema = process.env.REBUILD_SCHEMA;

  beforeEach(async () => {
    // A shadow target, so the live-schema guard is satisfied by the normal path.
    process.env.REBUILD_SCHEMA = 'truthbounty_shadow_test';

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('sqlite3'),
          entities: [
            CanonicalEvent,
            ProjectorCursor,
            IndexingAnomaly,
            ProjectEvidence,
            ProjectEvidenceVersion,
            ProjectVerificationRound,
            ProjectParticipantPosition,
            ProjectDispute,
            ProjectRewardAllocation,
            ProjectRewardPool,
            ProjectRewardClaim,
            ProjectionRebuildRun,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([CanonicalEvent, ProjectionRebuildRun]),
      ],
      providers: [
        ProjectionRebuildService,
        CanonicalEventQueryService,
        EvidenceProjectorService,
        VerificationProjectorService,
        DisputesProjectorService,
        RewardsProjectorService,
        {
          provide: PROJECTION_REGISTRY,
          inject: [
            DataSource,
            EvidenceProjectorService,
            VerificationProjectorService,
            DisputesProjectorService,
            RewardsProjectorService,
          ],
          useFactory: (
            ds: DataSource,
            evidence: EvidenceProjectorService,
            verification: VerificationProjectorService,
            disputes: DisputesProjectorService,
            rewards: RewardsProjectorService,
          ) =>
            buildDefaultRegistry(ds, { evidence, verification, disputes, rewards }),
        },
      ],
    }).compile();

    service = moduleRef.get(ProjectionRebuildService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef.close();
    if (originalSchema === undefined) {
      delete process.env.REBUILD_SCHEMA;
    } else {
      process.env.REBUILD_SCHEMA = originalSchema;
    }
  });

  async function seed(overrides: Partial<CanonicalEvent>): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: '0x' + 'aa'.repeat(20),
      artifactVersion: 'v1',
      txHash: '0x' + '00'.repeat(32),
      logIndex: 0,
      blockNumber: '1',
      claimId: CLAIM_ID,
      payload: {} as object,
      rawArgs: {} as object,
      ...overrides,
    });
  }

  /**
   * A canonical event log spanning blocks 900..1100, including one event
   * *before* the deployment block. The pre-deployment event must be ignored.
   */
  async function seedLog(): Promise<void> {
    // Before the deployment block — must be excluded by the rebuild.
    await seed({
      eventName: 'EvidenceRegistered',
      txHash: '0x' + 'e0'.repeat(32),
      blockNumber: '900',
      actor: ACTOR,
      payload: { digest: '0xdeadbeef' },
    });

    await seed({
      eventName: 'VerificationRoundOpened',
      txHash: '0x' + 'e1'.repeat(32),
      blockNumber: '1001',
      logIndex: 0,
      claimId: CLAIM_ID,
      roundId: ROUND_ID,
      payload: { roundType: 'first', roundNumber: '1' },
    });
    await seed({
      eventName: 'PositionCommitted',
      txHash: '0x' + 'e2'.repeat(32),
      blockNumber: '1002',
      logIndex: 0,
      claimId: CLAIM_ID,
      roundId: ROUND_ID,
      actor: ACTOR,
      payload: { stake: '1000', verdict: 'true' },
    });
    await seed({
      eventName: 'DisputeRaised',
      txHash: '0x' + 'e3'.repeat(32),
      blockNumber: '1003',
      logIndex: 0,
      claimId: CLAIM_ID,
      roundId: ROUND_ID,
      actor: ACTOR,
      asset: ASSET,
      amount: '5000',
      payload: {},
    });
    await seed({
      eventName: 'RewardPoolSettled',
      txHash: '0x' + 'e4'.repeat(32),
      blockNumber: '1004',
      logIndex: 0,
      claimId: CLAIM_ID,
      asset: ASSET,
      amount: '10000',
      payload: { poolId: 'pool-1', amount: '10000' },
    });
    await seed({
      eventName: 'RewardAllocated',
      txHash: '0x' + 'e5'.repeat(32),
      blockNumber: '1005',
      logIndex: 0,
      claimId: CLAIM_ID,
      roundId: ROUND_ID,
      actor: ACTOR,
      asset: ASSET,
      amount: '10000',
      payload: {
        kind: 'verifier',
        beneficiary: ACTOR,
        sourcePoolId: 'pool-1',
        amount: '10000',
      },
    });
  }

  describe('cutover safety guard', () => {
    it('refuses to run without a shadow target and without allowInPlace', async () => {
      delete process.env.REBUILD_SCHEMA;
      await expect(
        service.rebuild({
          chainId: 10,
          deploymentBlock: DEPLOYMENT_BLOCK,
          allowInPlace: false,
        }),
      ).rejects.toThrow(/REBUILD_SCHEMA/);
    });

    it('rejects a non-integer deployment block', async () => {
      await expect(
        service.rebuild({
          chainId: 10,
          deploymentBlock: 'not-a-block',
        }),
      ).rejects.toThrow(/base-10 integer string/);
    });

    it('never marks a partial run safe to cut over', async () => {
      await seedLog();
      const checkpoint = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        maxBatches: 1,
      });

      expect(checkpoint.complete).toBe(false);
      expect(checkpoint.safeToCutover).toBe(false);
    });
  });

  describe('replay from the deployment block', () => {
    it('rebuilds every projection and reports concrete counts', async () => {
      await seedLog();

      const checkpoint = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      expect(checkpoint.complete).toBe(true);
      expect(checkpoint.eventsConsumed).toBe(5); // 6 seeded, 1 pre-deployment
      expect(checkpoint.anomalies).toBe(0);
      expect(checkpoint.unclaimedEvents).toBe(0);
      expect(checkpoint.safeToCutover).toBe(true);

      expect(checkpoint.perProjection['v2-verification'].eventsApplied).toBe(2);
      expect(checkpoint.perProjection['v2-verification'].rowsInTable).toBe(2);
      expect(checkpoint.perProjection['v2-disputes'].eventsApplied).toBe(1);
      expect(checkpoint.perProjection['v2-disputes'].rowsInTable).toBe(1);
      expect(checkpoint.perProjection['v2-rewards'].eventsApplied).toBe(2);
      expect(checkpoint.perProjection['v2-rewards'].rowsInTable).toBe(2);
      expect(checkpoint.perProjection['v2-evidence'].eventsApplied).toBe(0);
      expect(checkpoint.perProjection['v2-evidence'].rowsInTable).toBe(0);
    });

    it('ignores canonical events before the deployment block', async () => {
      await seedLog();

      const checkpoint = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      // The only pre-deployment event is an EvidenceRegistered. If the
      // deployment block were ignored, evidence would have one row.
      expect(checkpoint.perProjection['v2-evidence'].eventsConsumed).toBe(0);
      expect(
        await dataSource.getRepository(ProjectEvidence).find(),
      ).toHaveLength(0);
    });

    it('is idempotent: re-running the same range re-applies nothing', async () => {
      await seedLog();
      const first = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });
      expect(first.complete).toBe(true);

      const second = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
      });

      // The canonical log is re-read (that is what a rebuild *is*), so the fold
      // counter moves. What must not move is any projection's applied count:
      // every write is guarded by the emitting event's unique constraint, so a
      // replay lands as a no-op.
      expect(second.eventsConsumed).toBe(5);
      expect(second.eventsApplied).toBe(0);
      for (const name of [
        'v2-evidence',
        'v2-verification',
        'v2-disputes',
        'v2-rewards',
      ]) {
        expect(second.perProjection[name].eventsApplied).toBe(0);
      }
      // Same events, same digest.
      expect(second.inputDigest).toBe(first.inputDigest);

      // And no duplicated state.
      expect(
        await dataSource.getRepository(ProjectRewardAllocation).find(),
      ).toHaveLength(1);
      expect(
        await dataSource.getRepository(ProjectParticipantPosition).find(),
      ).toHaveLength(1);
      expect(await dataSource.getRepository(ProjectDispute).find()).toHaveLength(
        1,
      );
    });

    it('reproduces the same digest from a full reset', async () => {
      await seedLog();
      const first = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });
      const second = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      expect(second.perProjection['v2-rewards'].eventsApplied).toBe(2);
      expect(second.safeToCutover).toBe(true);
      expect(second.inputDigest).toBe(first.inputDigest);
      expect(
        await dataSource.getRepository(ProjectRewardAllocation).find(),
      ).toHaveLength(1);
    });

    it('produces a byte-identical report for the same input', async () => {
      await seedLog();
      const first = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        eventBatchSize: 500,
        resetProjections: true,
      });
      const second = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        eventBatchSize: 1,
        resetProjections: true,
      });

      // Different batch sizes must not change the report. `batchesProcessed`
      // legitimately differs, so compare everything else.
      const strip = (c: typeof first) => ({ ...c, batchesProcessed: 0 });
      expect(service.render(strip(second))).toBe(service.render(strip(first)));
      expect(second.inputDigest).toBe(first.inputDigest);
    });

    it('changes the digest when the canonical log changes', async () => {
      await seedLog();
      const first = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      await seed({
        eventName: 'DisputeExpired',
        txHash: '0x' + 'e6'.repeat(32),
        blockNumber: '1006',
        logIndex: 0,
        claimId: CLAIM_ID,
        roundId: ROUND_ID,
        payload: {},
      });

      const second = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      expect(second.inputDigest).not.toBe(first.inputDigest);
      expect(second.eventsConsumed).toBe(first.eventsConsumed + 1);
    });
  });

  describe('resumability', () => {
    it('records a checkpoint after a bounded run and resumes from it to the same digest', async () => {
      await seedLog();

      const partial = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        maxBatches: 1,
        eventBatchSize: 1,
        resetProjections: true,
      });
      expect(partial.complete).toBe(false);
      expect(partial.eventsConsumed).toBeGreaterThan(0);
      // The resume point has advanced past the deployment block.
      expect(BigInt(partial.fromBlock)).toBeGreaterThan(
        BigInt(DEPLOYMENT_BLOCK),
      );

      const resumed = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        eventBatchSize: 1,
        resumeFrom: partial,
      });

      expect(resumed.complete).toBe(true);
      // Counters carry forward, so the resumed report describes the rebuild as
      // a whole and is directly comparable to an uninterrupted run.
      expect(resumed.eventsConsumed).toBe(5);
      expect(resumed.unclaimedEvents).toBe(0);

      // The resumed fold must land on exactly the same accumulator as an
      // uninterrupted run — that is the whole determinism claim.
      const uninterrupted = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        eventBatchSize: 1,
        resetProjections: true,
      });
      expect(resumed.inputDigest).toBe(uninterrupted.inputDigest);
      const strip = (c: typeof resumed) => ({ ...c, batchesProcessed: 0 });
      expect(service.render(strip(resumed))).toBe(
        service.render(strip(uninterrupted)),
      );
    });

    it('persists an auditable run row with the checkpoint and a terminal status', async () => {
      await seedLog();
      await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      const runs = await service.recentRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('completed');
      expect(runs[0].deploymentBlock).toBe(DEPLOYMENT_BLOCK);
      expect(runs[0].eventsConsumed).toBe(5);
      expect(runs[0].safeToCutover).toBe(true);
      expect(runs[0].finishedAt).not.toBeNull();
      expect(JSON.parse(runs[0].checkpointJson).inputDigest).toBe(
        runs[0].inputDigest,
      );
    });

    it('records a failed run row when the drain throws', async () => {
      await seedLog();
      const registry = moduleRef.get(PROJECTION_REGISTRY) as RebuildableProjection[];
      const broken: RebuildableProjection = {
        ...registry[0],
        run: async () => {
          throw new Error('simulated projector failure');
        },
      };

      const failing = new ProjectionRebuildService(dataSource, [broken]);
      await expect(
        failing.rebuild({
          chainId: 10,
          deploymentBlock: DEPLOYMENT_BLOCK,
          resetProjections: true,
        }),
      ).rejects.toThrow('simulated projector failure');

      const runs = await service.recentRuns();
      expect(runs[0].status).toBe('failed');
      expect(runs[0].error).toContain('simulated projector failure');
    });
  });

  describe('reconciliation accounting', () => {
    it('counts events no registered projection claims', async () => {
      await seed({
        eventName: 'SomeFutureProtocolEvent',
        txHash: '0x' + 'f0'.repeat(32),
        blockNumber: '1050',
        logIndex: 0,
        payload: {},
      });

      const checkpoint = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      expect(checkpoint.unclaimedEvents).toBe(1);
      // An unaccounted event blocks cutover: swapping in a read model that is
      // missing a projection is silent data loss.
      expect(checkpoint.safeToCutover).toBe(false);
    });

    it('counts a projector refusal as an anomaly and blocks cutover', async () => {
      // A RewardClaimed for an allocation that was never emitted: the projector
      // refuses to guess a beneficiary and records an anomaly.
      await seed({
        eventName: 'RewardClaimed',
        txHash: '0x' + 'f1'.repeat(32),
        blockNumber: '1050',
        logIndex: 0,
        claimId: CLAIM_ID,
        actor: ACTOR,
        amount: '1',
        payload: { amount: '1' },
      });

      const checkpoint = await service.rebuild({
        chainId: 10,
        deploymentBlock: DEPLOYMENT_BLOCK,
        resetProjections: true,
      });

      expect(checkpoint.anomalies).toBeGreaterThan(0);
      expect(checkpoint.perProjection['v2-rewards'].anomalies).toBeGreaterThan(0);
      expect(checkpoint.safeToCutover).toBe(false);
      expect(
        await dataSource.getRepository(IndexingAnomaly).find(),
      ).not.toHaveLength(0);
    });
  });
});
