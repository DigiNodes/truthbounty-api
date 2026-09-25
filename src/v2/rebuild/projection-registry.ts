import { DataSource, EntityTarget } from 'typeorm';
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

/**
 * Counters a V2 projector reports after a drain batch.
 *
 * `anomalies` and `duplicates` are both optional because the existing
 * projectors do not agree on a shape: `EvidenceProjectorService` reports
 * `duplicates`, while the verification, disputes, and rewards projectors report
 * `anomalies`. Both are accepted rather than "fixing" three projectors and four
 * specs in a change whose subject is the rebuild pipeline. They are also
 * genuinely different things — a duplicate is a safe no-op, an anomaly is a
 * refused event — so they are counted separately rather than conflated.
 */
export interface ProjectorRunSummary {
  processed: number;
  applied: number;
  anomalies?: number;
  duplicates?: number;
}

/**
 * One read model the rebuild pipeline knows how to re-derive.
 *
 * This is a thin, uniform adapter over the projectors that already exist. It
 * deliberately adds no projection logic of its own: `run()` calls the projector's
 * own `processNewEvents`, and `countRows()` reads the projector's own tables.
 * The rebuild pipeline's job is ordering, checkpointing, and reporting — not
 * re-deriving state by a second, divergent code path.
 */
export interface RebuildableProjection {
  /** Stable name, used as the report key. Must be deterministic. */
  readonly name: string;
  /**
   * The projector's own `ProjectorCursor.projectorName`. The rebuild pipeline
   * needs this to park each cursor at the deployment block, because a
   * projector that finds no cursor row starts from genesis rather than from
   * the deployment block.
   */
  readonly projectorName: string;
  /** Canonical event names this projection consumes. */
  readonly eventNames: readonly string[];
  /** Drain one batch. `processed === 0` means this projection is caught up. */
  run(batchSize: number): Promise<ProjectorRunSummary>;
  /** Row count across this projection's tables, for the report. */
  countRows(): Promise<number>;
  /** Remove all projected rows. Only ever called against a shadow target. */
  reset(): Promise<void>;
}

/** DI token for the ordered list of rebuildable projections. */
export const PROJECTION_REGISTRY = Symbol('PROJECTION_REGISTRY');

function tableCounter(
  dataSource: DataSource,
  targets: EntityTarget[],
): () => Promise<number> {
  return async () => {
    let total = 0;
    for (const target of targets) {
      total += await dataSource.getRepository(target).count();
    }
    return total;
  };
}

function tableResetter(
  dataSource: DataSource,
  targets: EntityTarget[],
): () => Promise<void> {
  return async () => {
    for (const target of targets) {
      await dataSource.getRepository(target).clear();
    }
  };
}

/**
 * The default registry, in **fixed order**.
 *
 * Order matters for reproducibility: projections are drained in this sequence
 * every time, so two rebuilds apply the same events in the same interleaving.
 * It is also the order the projectors consume the canonical log in
 * independently, so a projection never sees an event before the projection it
 * depends on has.
 *
 * Note what this list is *not*: it is not a list of every table in the schema.
 * Legacy `src/rewards` (the `RewardClaim`/`RewardDistribution` tables), the
 * `IndexedEvent` indexer tables, and the realtime `projection_events` outbox
 * are all fed by different pipelines and are out of scope for a V2 projection
 * rebuild. See `docs/PROJECTION_REBUILD.md` for that boundary.
 *
 * `eventNames` duplicates each projector's own private `HANDLED_EVENT_NAMES`,
 * because the registry needs the set for reconciliation and the projectors
 * correctly keep it private. That duplication is a drift risk, so the rebuild
 * report carries `unclaimedEvents`: the count of canonical events in range that
 * **no** registered projection claims. If a projector is registered with stale
 * event names, that number stops being zero.
 */
export function buildDefaultRegistry(
  dataSource: DataSource,
  projectors: {
    evidence: EvidenceProjectorService;
    verification: VerificationProjectorService;
    disputes: DisputesProjectorService;
    rewards: RewardsProjectorService;
  },
): RebuildableProjection[] {
  return [
    {
      name: 'v2-evidence',
      projectorName: 'v2-evidence',
      eventNames: ['EvidenceRegistered', 'EvidenceReplaced', 'EvidenceRemoved'],
      run: (batchSize) => projectors.evidence.processNewEvents(batchSize),
      countRows: tableCounter(dataSource, [ProjectEvidence, ProjectEvidenceVersion]),
      reset: tableResetter(dataSource, [ProjectEvidence, ProjectEvidenceVersion]),
    },
    {
      name: 'v2-verification',
      projectorName: 'v2-verification',
      eventNames: ['VerificationRoundOpened', 'PositionCommitted'],
      run: (batchSize) => projectors.verification.processNewEvents(batchSize),
      countRows: tableCounter(dataSource, [
        ProjectVerificationRound,
        ProjectParticipantPosition,
      ]),
      reset: tableResetter(dataSource, [
        ProjectVerificationRound,
        ProjectParticipantPosition,
      ]),
    },
    {
      name: 'v2-disputes',
      projectorName: 'v2-disputes',
      eventNames: ['DisputeRaised', 'DisputeResolved', 'DisputeExpired'],
      run: (batchSize) => projectors.disputes.processNewEvents(batchSize),
      countRows: tableCounter(dataSource, [ProjectDispute]),
      reset: tableResetter(dataSource, [ProjectDispute]),
    },
    {
      name: 'v2-rewards',
      projectorName: 'v2-rewards',
      eventNames: [
        'RewardPoolSettled',
        'RewardAllocated',
        'RewardClaimed',
      ],
      run: (batchSize) => projectors.rewards.processNewEvents(batchSize),
      countRows: tableCounter(dataSource, [
        ProjectRewardAllocation,
        ProjectRewardPool,
        ProjectRewardClaim,
      ]),
      reset: tableResetter(dataSource, [
        ProjectRewardAllocation,
        ProjectRewardPool,
        ProjectRewardClaim,
      ]),
    },
  ];
}
