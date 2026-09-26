import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';
import { EventQuarantine } from '../../events/entities/event-quarantine.entity';
import { ContractArtifact } from '../../events/entities/contract-artifact.entity';
import { ProjectorCursor } from '../entities/projector-cursor.entity';
import {
  PROJECTOR_HANDLED_EVENTS,
  V2_PROJECTOR_NAMES,
  V2ProjectorName,
  isV2ProjectorName,
} from './projector-registry';
import {
  ProjectionOrderKey,
  ProjectionReadiness,
  ProjectionReadinessCheck,
  ProjectionReadinessCheckStatus,
  ProjectionReadinessReason,
  ProjectionReadinessReport,
} from './projection-readiness.types';

/** Environment keys the gate reads. Documented in .env.example and the runbook. */
export const PROJECTION_READINESS_ENV = {
  quarantineMaxPending: 'PROJECTION_READINESS_QUARANTINE_MAX_PENDING',
} as const;

/**
 * Default: zero undecodable logs for an approved protocol contract may exist
 * while the projection is served as canonical state.
 */
export const DEFAULT_QUARANTINE_MAX_PENDING = 0;

/** Error code surfaced in the 503 body so callers can branch on it. */
export const PROJECTION_NOT_READY_ERROR = 'projection_not_ready';

const CHECK_PROJECTOR_REGISTERED = 'projector_registered';
const CHECK_CANONICAL_STREAM = 'canonical_event_stream';
const CHECK_CURSOR_CONSISTENCY = 'projector_cursor_consistency';
const CHECK_CATCH_UP = 'projector_catch_up';
const CHECK_QUARANTINE = 'protocol_log_quarantine';

function toBigInt(value: string | number, field: string): bigint {
  const normalized =
    typeof value === 'number' ? Math.trunc(value) : value.trim();
  try {
    return BigInt(normalized);
  } catch {
    // A non-numeric block coordinate means the row cannot be trusted as a
    // chain-native ordering key. That is an integrity failure, not a
    // "no data yet" case, so it must surface as unready rather than be
    // coerced to 0.
    throw new Error(`malformed ${field}: ${String(value)}`);
  }
}

function isAfter(
  candidate: ProjectionOrderKey,
  reference: ProjectionOrderKey,
): boolean {
  const candidateBlock = toBigInt(
    candidate.blockNumber,
    'candidate.blockNumber',
  );
  const referenceBlock = toBigInt(
    reference.blockNumber,
    'reference.blockNumber',
  );
  if (candidateBlock !== referenceBlock) return candidateBlock > referenceBlock;
  return candidate.logIndex > reference.logIndex;
}

/**
 * Projection Readiness Gate (V2-BE-100).
 *
 * TruthBounty treats the deployed Optimism/EVM contracts and their finalized
 * canonical events as protocol authority; the API is a deterministic
 * indexing, projection and delivery layer. A projected read model is only
 * allowed to be served while the API can *prove* it still reproduces that
 * authority. This service is that proof, or the refusal to give one.
 *
 * Invariants (all fail closed — an unprovable invariant is a failure, never a
 * warning that is served anyway):
 *
 *  I1  Evaluation is total. Any error raised while evaluating (dependency
 *      unavailable, malformed row, invalid configuration) is reported as
 *      `evaluation_error` with `ready: false`. There is no unchecked path
 *      that returns ready.
 *  I2  Only registered projectors can be ready. An unknown projector name has
 *      no declared event contract, so nothing can be asserted about it.
 *  I3  Canonical events for a projector imply a cursor. If events exist that
 *      the projector must consume but no cursor row was ever written, the
 *      projection may be empty or arbitrarily stale and is not ready.
 *  I4  The cursor never lags the canonical stream. A cursor behind the newest
 *      handled event is a backlog; a cursor ahead of it means the projection
 *      claims progress the canonical stream cannot substantiate.
 *  I5  Undecodable logs for an approved protocol contract block readiness.
 *      Quarantine entries prove the projection is knowingly incomplete, so
 *      serving it as canonical state would fabricate protocol truth.
 *      Quarantine entries from *unapproved* addresses are not protocol state
 *      and therefore cannot invalidate the projection.
 *
 * The gate never writes. It only reads the canonical stream, the projector
 * cursors, and the quarantine table, so evaluating readiness can never itself
 * mutate or advance protocol-derived state.
 */
@Injectable()
export class ProjectionReadinessService {
  private readonly logger = new Logger(ProjectionReadinessService.name);

  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly canonicalEvents: Repository<CanonicalEvent>,
    @InjectRepository(ProjectorCursor)
    private readonly projectorCursors: Repository<ProjectorCursor>,
    @InjectRepository(EventQuarantine)
    private readonly quarantine: Repository<EventQuarantine>,
    private readonly config: ConfigService,
  ) {}

  /** Evaluate every registered projector. */
  async evaluateAll(): Promise<ProjectionReadinessReport> {
    const projectors = await Promise.all(
      V2_PROJECTOR_NAMES.map((name) => this.evaluate(name)),
    );
    const ready = projectors.every((projection) => projection.ready);
    return {
      ready,
      status: ready ? 'ready' : 'not_ready',
      evaluatedAt: new Date().toISOString(),
      projectors,
    };
  }

  /**
   * Evaluate a single projector by name.
   *
   * Never throws: every failure, including an unexpected one, is returned as
   * an explicit not-ready verdict with a reason.
   */
  async evaluate(projector: string): Promise<ProjectionReadiness> {
    const evaluatedAt = new Date().toISOString();
    try {
      if (!isV2ProjectorName(projector)) {
        return this.verdict({
          projector,
          evaluatedAt,
          cursor: null,
          canonicalHead: null,
          pendingEvents: 0,
          quarantinedProtocolLogs: 0,
          quarantineThreshold: 0,
          reasons: [ProjectionReadinessReason.UNKNOWN_PROJECTOR],
          checks: [
            this.check(
              CHECK_PROJECTOR_REGISTERED,
              false,
              `"${projector}" is not a registered V2 projector (known: ${V2_PROJECTOR_NAMES.join(', ')})`,
            ),
          ],
        });
      }

      return await this.evaluateKnownProjector(projector, evaluatedAt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Projection readiness evaluation failed for "${projector}": ${detail}`,
      );
      return this.verdict({
        projector,
        evaluatedAt,
        cursor: null,
        canonicalHead: null,
        pendingEvents: 0,
        quarantinedProtocolLogs: 0,
        quarantineThreshold: 0,
        reasons: [ProjectionReadinessReason.EVALUATION_ERROR],
        checks: [
          this.check(
            'readiness_evaluation',
            false,
            `readiness could not be evaluated and is therefore not asserted: ${detail}`,
          ),
        ],
      });
    }
  }

  /**
   * Fail-closed accessor for read paths. Resolves only when the projection is
   * provably caught up with canonical events; otherwise throws 503 so the API
   * reports an unavailable projection instead of answering from state it
   * cannot vouch for.
   */
  async assertReady(projector: V2ProjectorName): Promise<void> {
    const readiness = await this.evaluate(projector);
    if (readiness.ready) return;

    throw new ServiceUnavailableException({
      statusCode: 503,
      error: PROJECTION_NOT_READY_ERROR,
      message:
        `Projection "${readiness.projector}" is not ready to serve protocol-derived reads: ` +
        readiness.reasons.join(', '),
      projector: readiness.projector,
      reasons: readiness.reasons,
      checks: readiness.checks,
      cursor: readiness.cursor,
      canonicalHead: readiness.canonicalHead,
      pendingEvents: readiness.pendingEvents,
      quarantinedProtocolLogs: readiness.quarantinedProtocolLogs,
      quarantineThreshold: readiness.quarantineThreshold,
      evaluatedAt: readiness.evaluatedAt,
    });
  }

  private async evaluateKnownProjector(
    projector: V2ProjectorName,
    evaluatedAt: string,
  ): Promise<ProjectionReadiness> {
    const eventNames = [...PROJECTOR_HANDLED_EVENTS[projector]];
    const quarantineThreshold = this.resolveQuarantineThreshold();

    const canonicalHead = await this.findCanonicalHead(eventNames);
    const cursorRow = await this.projectorCursors.findOne({
      where: { projectorName: projector },
    });

    const cursor: ProjectionOrderKey | null = cursorRow
      ? {
          blockNumber: String(cursorRow.lastBlockNumber),
          logIndex: cursorRow.lastLogIndex,
        }
      : null;

    const reasons: ProjectionReadinessReason[] = [];
    const checks: ProjectionReadinessCheck[] = [];

    let pendingEvents = 0;
    let cursorAheadOfStream = false;

    if (canonicalHead && cursor) {
      if (isAfter(cursor, canonicalHead)) {
        cursorAheadOfStream = true;
      } else {
        pendingEvents = await this.countPendingEvents(eventNames, cursor);
      }
    } else if (canonicalHead && !cursor) {
      pendingEvents = await this.countPendingEvents(eventNames, null);
    }

    // I3 — a projector with work to do must have a cursor.
    if (canonicalHead && !cursor) {
      reasons.push(ProjectionReadinessReason.CURSOR_MISSING);
      checks.push(
        this.check(
          CHECK_CURSOR_CONSISTENCY,
          false,
          `${pendingEvents} canonical event(s) exist for ${projector} but it has never recorded a cursor`,
        ),
      );
    } else if (cursorAheadOfStream && cursor) {
      // I4 — cannot claim progress the canonical stream does not contain.
      reasons.push(ProjectionReadinessReason.CURSOR_AHEAD_OF_STREAM);
      checks.push(
        this.check(
          CHECK_CURSOR_CONSISTENCY,
          false,
          `cursor ${cursor.blockNumber}:${cursor.logIndex} is ahead of canonical head ` +
            `${canonicalHead?.blockNumber}:${canonicalHead?.logIndex}`,
        ),
      );
    } else {
      checks.push(
        this.check(
          CHECK_CURSOR_CONSISTENCY,
          true,
          cursor
            ? `cursor ${cursor.blockNumber}:${cursor.logIndex} is within the canonical stream`
            : 'no canonical events to project yet',
        ),
      );
    }

    // I4 — the projection must be caught up with the canonical stream.
    if (pendingEvents > 0) {
      reasons.push(ProjectionReadinessReason.BACKLOG);
      checks.push(
        this.check(
          CHECK_CATCH_UP,
          false,
          `${pendingEvents} canonical event(s) are not yet projected`,
        ),
      );
    } else {
      checks.push(
        this.check(
          CHECK_CATCH_UP,
          true,
          'projection is caught up with canonical events',
        ),
      );
    }

    checks.push(
      this.check(
        CHECK_CANONICAL_STREAM,
        Boolean(canonicalHead) || Boolean(cursor),
        canonicalHead
          ? `canonical head ${canonicalHead.blockNumber}:${canonicalHead.logIndex}`
          : cursor
            ? 'cursor exists but the canonical stream is empty'
            : 'canonical stream is empty',
      ),
    );

    // I5 — undecodable logs from approved protocol contracts invalidate the projection.
    const quarantinedProtocolLogs = await this.countQuarantinedProtocolLogs();
    if (quarantinedProtocolLogs > quarantineThreshold) {
      reasons.push(ProjectionReadinessReason.QUARANTINE_BACKLOG);
      checks.push(
        this.check(
          CHECK_QUARANTINE,
          false,
          `${quarantinedProtocolLogs} undecodable log(s) from approved protocol contracts ` +
            `(allowed: ${quarantineThreshold}); the projection is knowingly incomplete`,
        ),
      );
    } else {
      checks.push(
        this.check(
          CHECK_QUARANTINE,
          true,
          `${quarantinedProtocolLogs} undecodable log(s) from approved protocol contracts ` +
            `(allowed: ${quarantineThreshold})`,
        ),
      );
    }

    checks.unshift(
      this.check(
        CHECK_PROJECTOR_REGISTERED,
        true,
        `${projector} is a registered V2 projector`,
      ),
    );

    return this.verdict({
      projector,
      evaluatedAt,
      cursor,
      canonicalHead,
      pendingEvents,
      quarantinedProtocolLogs,
      quarantineThreshold,
      reasons,
      checks,
    });
  }

  /**
   * Newest canonical event the projector is responsible for consuming.
   * Ordered by the protocol's own (blockNumber, logIndex) coordinates.
   */
  private async findCanonicalHead(
    eventNames: string[],
  ): Promise<ProjectionOrderKey | null> {
    const row = await this.canonicalEvents
      .createQueryBuilder('e')
      .select(['e.blockNumber', 'e.logIndex'])
      .where('e.eventName IN (:...eventNames)', { eventNames })
      .orderBy('e.blockNumber', 'DESC')
      .addOrderBy('e.logIndex', 'DESC')
      .limit(1)
      .getOne();

    if (!row) return null;
    return {
      blockNumber: String(row.blockNumber),
      logIndex: row.logIndex,
    };
  }

  /** Canonical events for this projector strictly after `after` (null = from genesis). */
  private async countPendingEvents(
    eventNames: string[],
    after: ProjectionOrderKey | null,
  ): Promise<number> {
    const qb = this.canonicalEvents
      .createQueryBuilder('e')
      .where('e.eventName IN (:...eventNames)', { eventNames });

    if (after) {
      qb.andWhere(
        '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
        { blockNumber: after.blockNumber, logIndex: after.logIndex },
      );
    }

    return qb.getCount();
  }

  /**
   * Quarantined logs whose address is an *approved* artifact. These are real
   * protocol logs this pipeline failed to decode (unknown signature, artifact
   * drift, decode error), so their events are missing from every projection.
   */
  private async countQuarantinedProtocolLogs(): Promise<number> {
    return this.quarantine
      .createQueryBuilder('q')
      .innerJoin(
        ContractArtifact,
        'a',
        'a.chainId = q.chainId AND a.contractAddress = q.contractAddress',
      )
      .where('a.isApproved = :approved', { approved: true })
      .getCount();
  }

  /**
   * Invalid or absent configuration falls back to the strict default; a
   * *malformed* value throws so it is reported as `evaluation_error` rather
   * than silently widened to permissive behavior.
   */
  private resolveQuarantineThreshold(): number {
    const raw = this.config.get<string | number>(
      PROJECTION_READINESS_ENV.quarantineMaxPending,
    );
    if (raw === undefined || raw === null || raw === '') {
      return DEFAULT_QUARANTINE_MAX_PENDING;
    }
    const parsed =
      typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `${PROJECTION_READINESS_ENV.quarantineMaxPending} must be a non-negative integer, got "${String(raw)}"`,
      );
    }
    return parsed;
  }

  private check(
    name: string,
    passed: boolean,
    detail: string,
  ): ProjectionReadinessCheck {
    return {
      name,
      status: passed
        ? ProjectionReadinessCheckStatus.PASS
        : ProjectionReadinessCheckStatus.FAIL,
      detail,
    };
  }

  private verdict(input: {
    projector: string;
    evaluatedAt: string;
    cursor: ProjectionOrderKey | null;
    canonicalHead: ProjectionOrderKey | null;
    pendingEvents: number;
    quarantinedProtocolLogs: number;
    quarantineThreshold: number;
    reasons: ProjectionReadinessReason[];
    checks: ProjectionReadinessCheck[];
  }): ProjectionReadiness {
    const ready = input.reasons.length === 0;
    return {
      projector: input.projector,
      ready,
      status: ready ? 'ready' : 'not_ready',
      evaluatedAt: input.evaluatedAt,
      cursor: input.cursor,
      canonicalHead: input.canonicalHead,
      pendingEvents: input.pendingEvents,
      quarantinedProtocolLogs: input.quarantinedProtocolLogs,
      quarantineThreshold: input.quarantineThreshold,
      reasons: input.reasons,
      checks: input.checks,
    };
  }
}
