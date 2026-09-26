import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RewardsProjectorService } from './rewards-projector.service';
import { RewardsReconciliationService } from './rewards-reconciliation.service';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { AllocationKind } from './reward-allocation-kind.enum';

const CLAIM_ID = '0x' + '11'.repeat(32);
const ROUND_ID = '0x' + 'aa'.repeat(32);
const ASSET = '0x' + '33'.repeat(20);
const SUBMITTER = '0x' + '22'.repeat(20);
const VERIFIER = '0x' + '44'.repeat(20);

describe('RewardsProjectorService (integration)', () => {
  let moduleRef: TestingModule;
  let projector: RewardsProjectorService;
  let reconciliation: RewardsReconciliationService;
  let dataSource: DataSource;

  async function seedEvent(overrides: Partial<CanonicalEvent>): Promise<void> {
    await dataSource.getRepository(CanonicalEvent).insert({
      chainId: 10,
      contractAddress: '0x' + 'aa'.repeat(20),
      artifactVersion: 'v1',
      txHash: '0x' + '00'.repeat(32),
      logIndex: 0,
      blockNumber: '1',
      claimId: CLAIM_ID,
      roundId: ROUND_ID,
      asset: ASSET,
      payload: {} as object,
      rawArgs: {} as object,
      ...overrides,
    });
  }

  function seedPoolSettled(
    poolId: string,
    poolAmount: string,
    blockNumber: string,
    tx: string,
    logIndex = 0,
  ): Promise<void> {
    return seedEvent({
      eventName: 'RewardPoolSettled',
      txHash: tx,
      logIndex,
      blockNumber,
      payload: { poolId, amount: poolAmount },
    });
  }

  function seedAllocated(opts: {
    tx: string;
    blockNumber: string;
    kind: string;
    beneficiary: string | null;
    amount: string;
    sourcePoolId: string;
    logIndex?: number;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    return seedEvent({
      eventName: 'RewardAllocated',
      txHash: opts.tx,
      logIndex: opts.logIndex ?? 0,
      blockNumber: opts.blockNumber,
      actor: opts.beneficiary,
      amount: opts.amount,
      payload: {
        kind: opts.kind,
        beneficiary: opts.beneficiary,
        sourcePoolId: opts.sourcePoolId,
        amount: opts.amount,
        ...(opts.extra ?? {}),
      },
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
            ProjectRewardAllocation,
            ProjectRewardPool,
            ProjectRewardClaim,
            ProjectorCursor,
            IndexingAnomaly,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          ProjectRewardAllocation,
          ProjectRewardPool,
          ProjectRewardClaim,
          ProjectorCursor,
          IndexingAnomaly,
          CanonicalEvent,
        ]),
      ],
      providers: [
        RewardsProjectorService,
        RewardsReconciliationService,
        CanonicalEventQueryService,
      ],
    }).compile();

    projector = moduleRef.get(RewardsProjectorService);
    reconciliation = moduleRef.get(RewardsReconciliationService);
    dataSource = moduleRef.get(DataSource);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('allocation projection', () => {
    it('projects a RewardAllocated event verbatim, with claimable but not yet claimed', async () => {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'submitter',
        beneficiary: SUBMITTER,
        amount: '6000',
        sourcePoolId: 'pool-1',
      });

      const summary = await projector.processNewEvents();
      expect(summary.processed).toBe(1);
      expect(summary.applied).toBe(1);
      expect(summary.anomalies).toBe(0);

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe(AllocationKind.SUBMITTER);
      expect(rows[0].allocatedAmount).toBe('6000');
      expect(rows[0].claimedAmount).toBe('0');
      expect(rows[0].beneficiary).toBe(SUBMITTER);
      expect(rows[0].claimId).toBe(CLAIM_ID);
      expect(rows[0].sourcePoolId).toBe('pool-1');
    });

    it.each([
      [AllocationKind.SUBMITTER, 1],
      [AllocationKind.VERIFIER, 2],
      [AllocationKind.CHALLENGER, 3],
      [AllocationKind.TREASURY, 4],
      [AllocationKind.REFUND, 5],
    ])(
      'projects the %s allocation kind on equal footing with the others',
      async (kind, index) => {
        await seedAllocated({
          tx: '0x' + String(index).repeat(32),
          blockNumber: '100',
          kind,
          beneficiary: kind === 'treasury' ? null : VERIFIER,
          amount: '1000',
          sourcePoolId: `pool-${kind}`,
        });

        await projector.processNewEvents();

        const rows = await dataSource
          .getRepository(ProjectRewardAllocation)
          .find();
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe(kind);
        // A treasury allocation has no externally-owned beneficiary. It is
        // recorded as null rather than being given a placeholder address.
        expect(rows[0].beneficiary).toBe(kind === 'treasury' ? null : VERIFIER);
      },
    );

    it('rejects an allocation whose kind is not one of the five, recording an anomaly', async () => {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'slashed',
        beneficiary: SUBMITTER,
        amount: '6000',
        sourcePoolId: 'pool-1',
      });

      const summary = await projector.processNewEvents();
      expect(summary.anomalies).toBe(1);

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows).toHaveLength(0);

      const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
      expect(anomalies[0].kind).toBe(IndexingAnomalyKind.OUT_OF_ORDER);
      expect(anomalies[0].detail).toContain('slashed');
    });

    it('rejects a non-integer amount rather than recording it as zero', async () => {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '1000.5',
        sourcePoolId: 'pool-1',
      });

      const summary = await projector.processNewEvents();
      expect(summary.anomalies).toBe(1);
      expect(
        await dataSource.getRepository(ProjectRewardAllocation).find(),
      ).toHaveLength(0);
    });

    it('is replay-safe: reprocessing does not duplicate allocations', async () => {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '2500',
        sourcePoolId: 'pool-1',
      });

      await projector.processNewEvents();
      const secondRun = await projector.processNewEvents();
      expect(secondRun.processed).toBe(0);
      expect(
        await dataSource.getRepository(ProjectRewardAllocation).find(),
      ).toHaveLength(1);
    });
  });

  describe('claim tracking', () => {
    async function seedOneAllocation(): Promise<void> {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '2500',
        sourcePoolId: 'pool-1',
        extra: { allocationId: 'alloc-1' },
      });
    }

    it('accumulates an emitted RewardClaimed against the allocation', async () => {
      await seedOneAllocation();
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '02'.repeat(32),
        blockNumber: '200',
        actor: VERIFIER,
        amount: '1000',
        payload: { allocationId: 'alloc-1', amount: '1000' },
      });

      await projector.processNewEvents();

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows[0].claimedAmount).toBe('1000');
      expect(rows[0].lastClaimBlockNumber).toBe('200');
      expect(rows[0].lastClaimEvent).toBe(`0x${'02'.repeat(32)}:0`);
    });

    it('sums successive partial claims exactly', async () => {
      await seedOneAllocation();
      for (const [index, amount] of ['1', '2', '3'].entries()) {
        await seedEvent({
          eventName: 'RewardClaimed',
          txHash: '0x' + '0' + index + '2'.repeat(31),
          blockNumber: String(200 + index),
          actor: VERIFIER,
          amount,
          payload: { allocationId: 'alloc-1', amount },
        });
      }

      await projector.processNewEvents();

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows[0].claimedAmount).toBe('6');
    });

    it('REFUSES a claim that would exceed the allocation, and records an anomaly', async () => {
      await seedOneAllocation();
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '02'.repeat(32),
        blockNumber: '200',
        actor: VERIFIER,
        amount: '2501',
        payload: { allocationId: 'alloc-1', amount: '2501' },
      });

      const summary = await projector.processNewEvents();
      expect(summary.anomalies).toBe(1);

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      // The read model must never assert that more was claimed than the
      // contract allocated. The divergence stays observable in the anomaly log.
      expect(rows[0].claimedAmount).toBe('0');

      const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
      expect(anomalies[0].kind).toBe(IndexingAnomalyKind.INVALID_TRANSITION);
      expect(anomalies[0].detail).toContain('2501');
    });

    it('refuses a second claim that would cross the allocation boundary', async () => {
      await seedOneAllocation();
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '02'.repeat(32),
        blockNumber: '200',
        actor: VERIFIER,
        amount: '2000',
        payload: { allocationId: 'alloc-1', amount: '2000' },
      });
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '03'.repeat(32),
        blockNumber: '300',
        actor: VERIFIER,
        amount: '600',
        payload: { allocationId: 'alloc-1', amount: '600' },
      });

      const summary = await projector.processNewEvents();
      expect(summary.applied).toBe(1);
      expect(summary.anomalies).toBe(1);

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows[0].claimedAmount).toBe('2000');
    });

    it('does not guess a beneficiary when a claim cannot be attributed', async () => {
      await seedOneAllocation();
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '02'.repeat(32),
        blockNumber: '200',
        actor: '0x' + '99'.repeat(20),
        amount: '500',
        payload: { amount: '500' },
      });

      const summary = await projector.processNewEvents();
      expect(summary.anomalies).toBe(1);

      const rows = await dataSource
        .getRepository(ProjectRewardAllocation)
        .find();
      expect(rows[0].claimedAmount).toBe('0');

      const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
      expect(anomalies[0].kind).toBe(IndexingAnomalyKind.OUT_OF_ORDER);
      expect(anomalies[0].detail).toContain('could not be attributed');
    });

    it('accepts a full claim that exactly exhausts the allocation', async () => {
      await seedOneAllocation();
      await seedEvent({
        eventName: 'RewardClaimed',
        txHash: '0x' + '02'.repeat(32),
        blockNumber: '200',
        actor: VERIFIER,
        amount: '2500',
        payload: { allocationId: 'alloc-1', amount: '2500' },
      });

      const summary = await projector.processNewEvents();
      expect(summary.applied).toBe(2);
      expect(summary.anomalies).toBe(0);

      const report = await reconciliation.reconcileChain(10);
      expect(report.allocations[0].status).toBe('claimed');
      expect(report.allocations[0].claimableRemaining).toBe('0');
    });
  });

  describe('pool reconciliation', () => {
    it('reports a balanced pool when the allocations sum to the emitted total', async () => {
      await seedPoolSettled('pool-1', '10000', '50', '0x' + '05'.repeat(32));
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'submitter',
        beneficiary: SUBMITTER,
        amount: '6000',
        sourcePoolId: 'pool-1',
      });
      await seedAllocated({
        tx: '0x' + '02'.repeat(32),
        blockNumber: '110',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '2500',
        sourcePoolId: 'pool-1',
      });
      await seedAllocated({
        tx: '0x' + '03'.repeat(32),
        blockNumber: '120',
        kind: 'treasury',
        beneficiary: null,
        amount: '1500',
        sourcePoolId: 'pool-1',
      });

      await projector.processNewEvents();

      const report = await reconciliation.reconcileChain(10);
      expect(report.pools).toHaveLength(1);
      expect(report.pools[0].poolAmount).toBe('10000');
      expect(report.pools[0].allocatedTotal).toBe('10000');
      expect(report.pools[0].divergent).toBe(false);
      expect(report.summary.divergentPoolCount).toBe(0);
      expect(report.summary.totalAllocated).toBe('10000');
      expect(report.summary.totalClaimed).toBe('0');
      expect(report.summary.allocatedByKind[AllocationKind.TREASURY]).toBe(
        '1500',
      );
    });

    it('reports divergence when the projected allocations under-account for the pool', async () => {
      await seedPoolSettled('pool-1', '10000', '50', '0x' + '05'.repeat(32));
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'submitter',
        beneficiary: SUBMITTER,
        amount: '6000',
        sourcePoolId: 'pool-1',
      });

      await projector.processNewEvents();

      const report = await reconciliation.reconcileChain(10);
      expect(report.pools[0].divergent).toBe(true);
      expect(report.pools[0].divergence).toBe('4000');
      expect(report.summary.divergentPoolCount).toBe(1);
    });

    it('treats a settled pool with no projected allocations as divergent, not balanced', async () => {
      await seedPoolSettled('pool-1', '10000', '50', '0x' + '05'.repeat(32));

      await projector.processNewEvents();

      const report = await reconciliation.reconcileChain(10);
      expect(report.pools[0].divergent).toBe(true);
      expect(report.pools[0].allocationCount).toBe(0);
    });

    it('rejects a second settlement of the same pool, keeping the first authoritative', async () => {
      await seedPoolSettled('pool-1', '10000', '50', '0x' + '05'.repeat(32));
      await seedPoolSettled('pool-1', '99999', '400', '0x' + '06'.repeat(32));

      const summary = await projector.processNewEvents();
      expect(summary.applied).toBe(1);
      expect(summary.anomalies).toBe(1);

      const pools = await dataSource.getRepository(ProjectRewardPool).find();
      expect(pools).toHaveLength(1);
      expect(pools[0].poolAmount).toBe('10000');

      const anomalies = await dataSource.getRepository(IndexingAnomaly).find();
      expect(anomalies[0].kind).toBe(IndexingAnomalyKind.DUPLICATE_EVENT);
    });

    it('lists allocations for a claim and by kind', async () => {
      await seedAllocated({
        tx: '0x' + '01'.repeat(32),
        blockNumber: '100',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '2500',
        sourcePoolId: 'pool-1',
      });
      await seedAllocated({
        tx: '0x' + '02'.repeat(32),
        blockNumber: '110',
        kind: 'verifier',
        beneficiary: VERIFIER,
        amount: '1500',
        sourcePoolId: 'pool-1',
      });

      await projector.processNewEvents();

      const forClaim = await reconciliation.listForClaim(10, CLAIM_ID);
      expect(forClaim).toHaveLength(2);

      const verifiers = await reconciliation.listByKind(10, AllocationKind.VERIFIER);
      expect(verifiers).toHaveLength(2);
    });
  });
});
