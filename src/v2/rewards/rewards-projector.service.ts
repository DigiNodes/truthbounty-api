import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import { parseAllocationKind } from './reward-allocation-kind.enum';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';

const PROJECTOR_NAME = 'v2-rewards';
const PG_UNIQUE_VIOLATION = '23505';
/** Canonical event names this projector consumes. Exported for the rebuild
 *  pipeline's projection registry (`src/v2/rebuild/`), which needs to know the
 *  full event-name set to assert that a rebuild consumed everything it should. */
export const REWARD_ALLOCATION_EVENT_NAMES = [
  'RewardPoolSettled',
  'RewardAllocated',
  'RewardClaimed',
] as const;

export interface ProjectorRunSummary {
  processed: number;
  applied: number;
  anomalies: number;
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

/**
 * Parse a canonical event amount into a `bigint`.
 *
 * Returns `null` for anything that is not a base-10 integer string. Callers
 * must treat `null` as "reject the event and record an anomaly". There is no
 * `parseFloat` fallback anywhere in this file: a 256-bit token amount must
 * never pass through a double, and a malformed amount must never silently
 * become `0` (which would read as "this beneficiary was allocated nothing"
 * and is a materially different claim from "we could not read this event").
 */
function readAmount(
  payload: Record<string, unknown>,
  key: string,
): bigint | null {
  const raw = readString(payload, key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function lower(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

/**
 * Projects reward allocations and claim progress from canonical events
 * (V2-BE-017).
 *
 * ## The rule this projector exists to obey
 *
 * The deployed Optimism/EVM contract is the only authority for who was
 * allocated what and who has collected it. This projector:
 *
 * - **reads** an allocation amount from a `RewardAllocated` event and stores it
 *   verbatim;
 * - **tracks** claim progress by summing amounts from `RewardClaimed` events
 *   the contract has already emitted;
 * - **records** a source pool's emitted total from `RewardPoolSettled` so the
 *   two can be reconciled;
 * - and does **nothing else**. It never apportions a pool, never computes a
 *   share, never decides a winner, and never fills a gap from a neighbouring
 *   event's data.
 *
 * Every place where it could be tempted to guess instead, it fails closed and
 * writes an `IndexingAnomaly`:
 *
 * | Situation | Outcome |
 * | --------- | ------- |
 * | `RewardAllocated` with no/unknown `kind` | anomaly, no row |
 * | `RewardAllocated` with a non-integer or absent `amount` | anomaly, no row |
 * | `RewardClaimed` that cannot be attributed to a known allocation | `out_of_order` anomaly, nothing credited |
 * | `RewardClaimed` that would push `claimed` above `allocated` | `invalid_transition` anomaly, **rejected** — `claimed` never exceeds `allocated` in this table |
 * | A second `RewardPoolSettled` for the same pool | `duplicate_event` anomaly, first one wins |
 * | Replay of an already-applied `RewardAllocated` | no-op (`duplicate`) |
 *
 * That last rejection is the load-bearing one. By refusing to record an
 * over-claim, the read model cannot present an amount as "claimed" that the
 * chain did not emit; the divergence stays in the anomaly log where an operator
 * will see it.
 *
 * ## ASSUMPTION FLAGGED FOR REVIEW
 *
 * V2-BE-008 (approved artifact import) has not landed, so there is no frozen
 * ABI to read real argument names from. The payload keys read here — `kind`,
 * `beneficiary`, `sourcePoolId`, `allocationId`, `poolId` — follow the
 * vocabulary of the V2-BE-017 issue text and the convention documented in
 * `../events/event-schema-registry.ts`. They are expected to be reconciled
 * against the real approved ABI once V2-BE-008 exists. Nothing in this file
 * changes protocol meaning: it only says where to look for each field.
 */
@Injectable()
export class RewardsProjectorService {
  private readonly logger = new Logger(RewardsProjectorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly canonicalEvents: CanonicalEventQueryService,
  ) {}

  async processNewEvents(batchSize = 100): Promise<ProjectorRunSummary> {
    const cursorRepo = this.dataSource.getRepository(ProjectorCursor);
    const cursor = await cursorRepo.findOne({
      where: { projectorName: PROJECTOR_NAME },
    });
    const after = cursor
      ? { blockNumber: cursor.lastBlockNumber, logIndex: cursor.lastLogIndex }
      : null;

    const events = await this.canonicalEvents.findAfter(
      [...REWARD_ALLOCATION_EVENT_NAMES],
      after,
      batchSize,
    );
    const summary: ProjectorRunSummary = {
      processed: 0,
      applied: 0,
      anomalies: 0,
    };

    for (const event of events) {
      summary.processed += 1;
      const outcome = await this.applyEvent(event);
      if (outcome === 'applied') summary.applied += 1;
      if (outcome === 'anomaly') summary.anomalies += 1;

      await cursorRepo.upsert(
        {
          projectorName: PROJECTOR_NAME,
          lastBlockNumber: event.blockNumber,
          lastLogIndex: event.logIndex,
        },
        ['projectorName'],
      );
    }

    return summary;
  }

  private async applyEvent(
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    if (event.eventName === 'RewardPoolSettled') {
      return this.applyPoolSettled(event);
    }
    if (event.eventName === 'RewardAllocated') {
      return this.applyAllocated(event);
    }
    if (event.eventName === 'RewardClaimed') {
      return this.applyClaimed(event);
    }
    return 'duplicate';
  }

  // ─── RewardPoolSettled ──────────────────────────────────────────────────

  private async applyPoolSettled(
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    const poolId = readString(event.payload, 'poolId');
    const poolAmount = readAmount(event.payload, 'amount');

    if (!event.claimId || !event.asset || !poolId || poolAmount === null) {
      await this.recordAnomaly(
        IndexingAnomalyKind.OUT_OF_ORDER,
        poolId ?? `${event.txHash}:${event.logIndex}`,
        event,
        'RewardPoolSettled rejected: missing claimId/asset/poolId or a non-integer amount',
      );
      return 'anomaly';
    }

    const poolRepo = this.dataSource.getRepository(ProjectRewardPool);
    try {
      await poolRepo.insert({
        poolId,
        chainId: event.chainId,
        claimId: event.claimId!,
        asset: event.asset!.toLowerCase(),
        poolAmount: poolAmount.toString(),
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
      return 'applied';
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;

      // Either a safe replay of the same event, or a genuinely second settle
      // for a pool that already settled. Both are non-fatal; the first is a
      // replay, the second is a protocol-level fact worth surfacing.
      const existing = await poolRepo.findOne({
        where: {
          eventTxHash: event.txHash,
          eventLogIndex: event.logIndex,
        },
      });
      if (existing) return 'duplicate';

      await this.recordAnomaly(
        IndexingAnomalyKind.DUPLICATE_EVENT,
        poolId,
        event,
        `Pool ${poolId} was already settled; the first settlement is authoritative`,
      );
      return 'anomaly';
    }
  }

  // ─── RewardAllocated ────────────────────────────────────────────────────

  private async applyAllocated(
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    const kind = parseAllocationKind(readString(event.payload, 'kind'));
    const amount = readAmount(event.payload, 'amount');
    const beneficiary = lower(
      readString(event.payload, 'beneficiary') ?? event.actor,
    );
    const sourcePoolId =
      readString(event.payload, 'sourcePoolId') ??
      (event.claimId ? `claim:${event.claimId}` : null);

    if (
      !event.claimId ||
      !event.asset ||
      kind === null ||
      amount === null ||
      sourcePoolId === null
    ) {
      await this.recordAnomaly(
        IndexingAnomalyKind.OUT_OF_ORDER,
        sourcePoolId ?? `${event.txHash}:${event.logIndex}`,
        event,
        'RewardAllocated rejected: missing claimId/asset/sourcePoolId, an unrecognised ' +
          `kind, or a non-integer amount (kind=${readString(event.payload, 'kind') ?? '<absent>'})`,
      );
      return 'anomaly';
    }

    const allocationRepo = this.dataSource.getRepository(ProjectRewardAllocation);
    try {
      await allocationRepo.insert({
        allocationId: this.deriveAllocationId(event),
        chainId: event.chainId,
        claimId: event.claimId!,
        roundId: event.roundId,
        sourcePoolId,
        kind,
        beneficiary,
        asset: event.asset!.toLowerCase(),
        allocatedAmount: amount.toString(),
        claimedAmount: '0',
        lastClaimBlockNumber: null,
        lastClaimEvent: null,
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
      return 'applied';
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;

      const existing = await allocationRepo.findOne({
        where: { eventTxHash: event.txHash, eventLogIndex: event.logIndex },
      });
      if (existing) return 'duplicate'; // safe replay

      // The primary key is the allocation id, so this branch is only reachable
      // when the contract supplied an id that a *different* event already used.
      await this.recordAnomaly(
        IndexingAnomalyKind.DUPLICATE_EVENT,
        this.deriveAllocationId(event),
        event,
        `Allocation id ${this.deriveAllocationId(event)} was already claimed by a ` +
          'different event; the first allocation is authoritative',
      );
      return 'anomaly';
    }
  }

  // ─── RewardClaimed ──────────────────────────────────────────────────────

  private async applyClaimed(
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    const amount = readAmount(event.payload, 'amount');
    if (!event.claimId || amount === null) {
      await this.recordAnomaly(
        IndexingAnomalyKind.OUT_OF_ORDER,
        `${event.txHash}:${event.logIndex}`,
        event,
        'RewardClaimed rejected: missing claimId or a non-integer amount',
      );
      return 'anomaly';
    }

    const allocationRepo = this.dataSource.getRepository(ProjectRewardAllocation);
    const allocation = await this.resolveAllocationTarget(event);

    if (!allocation) {
      // We will not infer which allocation was claimed. The contract emitted a
      // claim we cannot attribute, and guessing would mean the backend deciding
      // whose balance moved.
      //
      // Note that no withdrawal row is written either, so if the allocating
      // event is projected later — a resumed run, a backfill, a re-ingest — the
      // claim can still be attributed on a later pass. Refusing to record it is
      // what makes that possible; recording it as unattributed would not.
      await this.recordAnomaly(
        IndexingAnomalyKind.OUT_OF_ORDER,
        readString(event.payload, 'allocationId') ??
          `${event.claimId}:${lower(event.actor) ?? '<no beneficiary>'}`,
        event,
        `RewardClaimed could not be attributed to a known allocation on claim ${event.claimId}`,
      );
      return 'anomaly';
    }

    const allocated = BigInt(allocation.allocatedAmount);
    const claimed = BigInt(allocation.claimedAmount);
    const next = claimed + amount;

    if (next > allocated) {
      // Fail closed. Recording this would make the read model assert that more
      // was claimed than the contract ever allocated, which is exactly the
      // kind of backend-authored protocol truth this service must not produce.
      await this.recordAnomaly(
        IndexingAnomalyKind.INVALID_TRANSITION,
        allocation.allocationId,
        event,
        `RewardClaimed rejected: would take claimed to ${next.toString()} against ` +
          `an allocation of ${allocated.toString()} for ${allocation.allocationId}`,
      );
      return 'anomaly';
    }

    // The withdrawal row goes in *first*. It is the idempotency guard for the
    // only counter in this projection: a replay of this exact event violates
    // its unique constraint and returns before the total is touched. Writing
    // the counter first would double-count on every replay.
    const withdrawalRepo = this.dataSource.getRepository(ProjectRewardClaim);
    try {
      await withdrawalRepo.insert({
        withdrawalId: this.deriveWithdrawalId(event),
        chainId: event.chainId,
        allocationId: allocation.allocationId,
        claimId: allocation.claimId,
        beneficiary: allocation.beneficiary,
        asset: allocation.asset,
        amount: amount.toString(),
        claimTxHash: event.txHash,
        claimLogIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      return 'duplicate'; // safe replay of a withdrawal already recorded
    }

    allocation.claimedAmount = next.toString();
    allocation.lastClaimBlockNumber = event.blockNumber;
    allocation.lastClaimEvent = `${event.txHash}:${event.logIndex}`;
    await allocationRepo.save(allocation);
    return 'applied';
  }

  /**
   * Resolve which allocation a `RewardClaimed` belongs to.
   *
   * Resolution is by protocol-supplied `allocationId` when present — that is
   * exact. Otherwise it falls back to the `(claim, kind, beneficiary)` triple
   * the event carries, taking the *earliest* matching allocation. Earliest is
   * chosen because it is a pure function of already-projected state, so a
   * replay resolves to the same row it resolved to the first time; a "most
   * recent" or "largest" rule would make the result depend on projection order.
   *
   * There is no third fallback. If the event carries neither an allocation id
   * nor enough of a triple to match, this returns `null` and the caller records
   * an anomaly rather than picking the most plausible row.
   */
  private async resolveAllocationTarget(
    event: CanonicalEvent,
  ): Promise<ProjectRewardAllocation | null> {
    const repo = this.dataSource.getRepository(ProjectRewardAllocation);
    const allocationId = readString(event.payload, 'allocationId');
    if (allocationId) {
      return repo.findOne({ where: { allocationId } });
    }

    const kind = parseAllocationKind(readString(event.payload, 'kind'));
    const beneficiary = lower(
      readString(event.payload, 'beneficiary') ?? event.actor,
    );
    if (!kind || !beneficiary) return null;

    const candidates = await repo.find({
      where: {
        chainId: event.chainId,
        claimId: event.claimId!,
        kind,
        beneficiary,
      },
      order: { blockNumber: 'ASC', eventLogIndex: 'ASC' },
    });
    return candidates[0] ?? null;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Deterministic allocation id: the protocol's own when it supplies one,
   * otherwise a pure function of the creating event's chain identity. Either
   * way, a replay of the same event reconstructs the same key — which is what
   * makes the `allocationId` primary key a safe idempotency anchor.
   */
  private deriveAllocationId(event: CanonicalEvent): string {
    const supplied = readString(event.payload, 'allocationId');
    if (supplied) return supplied;
    return `${event.chainId}:${event.txHash}:${event.logIndex}`;
  }

  /**
   * Deterministic withdrawal identity for a `RewardClaimed` event. Same
   * derivation rule as {@link deriveAllocationId} and for the same reason: a
   * replay must reconstruct the identical key, because that key is what makes
   * the insert idempotent.
   */
  private deriveWithdrawalId(event: CanonicalEvent): string {
    const supplied = readString(event.payload, 'withdrawalId');
    if (supplied) return supplied;
    return `${event.chainId}:${event.txHash}:${event.logIndex}`;
  }

  private async recordAnomaly(
    kind: IndexingAnomalyKind,
    aggregateId: string,
    event: CanonicalEvent,
    detail: string,
  ): Promise<void> {
    this.logger.warn(`${kind}: ${detail}`);
    try {
      await this.dataSource.getRepository(IndexingAnomaly).insert({
        sourceModule: PROJECTOR_NAME,
        kind,
        aggregateId,
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
        detail,
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
  }
}
