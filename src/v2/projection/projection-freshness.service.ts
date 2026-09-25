import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockchainStateService } from '../../blockchain/state.service';
import { DataState } from '../common/data-state.enum';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  KNOWN_PROJECTORS,
  ProjectionFreshness,
  ProjectionFreshnessList,
  ProjectionStatus,
} from './projection-freshness.types';

const PROJECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Read-only aggregation of projection freshness and finality metadata.
 *
 * Sources (in priority order):
 * 1. `v2_projector_cursors` — durable per-projector progress; `updatedAt`
 *    is the natural `lastSuccess`.
 * 2. `v2_event_checkpoints` — DB primary for safe/finalized heights.
 * 3. `BlockchainStateService.getIndexerHealth()` — live observed head plus
 *    fallback safe/finalized cursors when no checkpoint row exists yet.
 *
 * Never writes, never signs, never settles: pure derived read model.
 * Idempotent and safe to retry concurrently.
 */
@Injectable()
export class ProjectionFreshnessService {
  private readonly logger = new Logger(ProjectionFreshnessService.name);

  constructor(
    @InjectRepository(ProjectorCursor)
    private readonly cursorRepo: Repository<ProjectorCursor>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    private readonly blockchainState: BlockchainStateService,
  ) {}

  async listFreshness(): Promise<ProjectionFreshnessList> {
    const names = await this.collectProjectorNames();
    const items: ProjectionFreshness[] = [];
    for (const name of names) {
      items.push(await this.buildFreshness(name));
    }
    return { timestamp: new Date().toISOString(), items };
  }

  async getFreshness(projectorName: string): Promise<ProjectionFreshness> {
    const normalized = this.normalizeName(projectorName);
    const known = await this.collectProjectorNames();
    if (!known.includes(normalized)) {
      throw new NotFoundException(
        `No projection freshness tracked for projector ${normalized}`,
      );
    }
    return this.buildFreshness(normalized);
  }

  private normalizeName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new BadRequestException('projectorName is required');
    }
    const name = raw.trim();
    if (!PROJECTOR_NAME_PATTERN.test(name)) {
      throw new BadRequestException(
        'projectorName must match [a-z0-9-], start alphanumeric, max 64 chars',
      );
    }
    return name;
  }

  /** Union of known projectors and any extra cursors persisted in the DB. */
  private async collectProjectorNames(): Promise<string[]> {
    const names = new Set<string>(KNOWN_PROJECTORS as readonly string[]);
    try {
      const cursors = await this.cursorRepo.find({ select: ['projectorName'] });
      for (const cursor of cursors) {
        if (
          typeof cursor.projectorName === 'string' &&
          PROJECTOR_NAME_PATTERN.test(cursor.projectorName)
        ) {
          names.add(cursor.projectorName);
        }
      }
    } catch (err) {
      // Fail closed but stay available: cursor enumeration is best-effort;
      // per-projector reads below will surface the underlying failure.
      this.logger.warn(
        `Projector cursor enumeration failed, falling back to known projectors: ${(err as Error)?.message ?? err}`,
      );
    }
    return [...names].sort();
  }

  private async buildFreshness(
    projectorName: string,
  ): Promise<ProjectionFreshness> {
    const reasons: string[] = [];
    let status: ProjectionStatus = 'healthy';

    const degrade = (reason: string) => {
      if (!reasons.includes(reason)) reasons.push(reason);
      if (status === 'healthy') status = 'degraded';
    };
    const failUnhealthy = (reason: string) => {
      if (!reasons.includes(reason)) reasons.push(reason);
      status = 'unhealthy';
    };

    const cursor = await this.readCursor(projectorName, degrade);
    const checkpoints = await this.readCheckpoints(degrade);

    let snapshot: Awaited<
      ReturnType<BlockchainStateService['getIndexerHealth']>
    > | null;
    try {
      snapshot = await this.blockchainState.getIndexerHealth();
    } catch (err) {
      this.logger.warn(
        `Indexer health snapshot unavailable for ${projectorName}: ${(err as Error)?.message ?? err}`,
      );
      snapshot = null;
      failUnhealthy('indexer-health-unavailable');
    }

    const indexedBlock = this.toBlockString(cursor?.lastBlockNumber);
    const indexedLogIndex = cursor?.lastLogIndex ?? null;
    const lastSuccess = cursor?.updatedAt
      ? new Date(cursor.updatedAt).toISOString()
      : null;

    if (!cursor) degrade('cursor-missing');

    const { safeHeight, finalizedHeight } = this.resolveFinality(
      checkpoints,
      snapshot,
      degrade,
    );

    const observedHead =
      snapshot && Number.isFinite(snapshot.observedHeadBlock)
        ? snapshot.observedHeadBlock
        : null;
    if (observedHead === null) degrade('head-unavailable');

    if (snapshot) {
      if (snapshot.status === 'unhealthy') {
        failUnhealthy('indexer-unhealthy');
      } else if (snapshot.status === 'degraded') {
        degrade('indexer-degraded');
      }
    }

    const headDistance = this.computeHeadDistance(
      observedHead,
      indexedBlock,
      degrade,
    );
    const dataState = this.classifyDataState(
      indexedBlock,
      safeHeight,
      finalizedHeight,
    );

    return {
      projectorName,
      indexedBlock,
      indexedLogIndex,
      finalizedHeight,
      safeHeight,
      observedHead,
      headDistance,
      lastSuccess,
      status,
      degradedReason: reasons.length > 0 ? reasons.join('; ') : null,
      dataState,
    };
  }

  private async readCursor(
    projectorName: string,
    degrade: (reason: string) => void,
  ): Promise<ProjectorCursor | null> {
    try {
      return await this.cursorRepo.findOne({ where: { projectorName } });
    } catch (err) {
      this.logger.warn(
        `Projector cursor read failed for ${projectorName}: ${(err as Error)?.message ?? err}`,
      );
      degrade('cursor-unavailable');
      return null;
    }
  }

  private async readCheckpoints(
    degrade: (reason: string) => void,
  ): Promise<EventCheckpoint[]> {
    try {
      return await this.checkpointRepo.find();
    } catch (err) {
      this.logger.warn(
        `Event checkpoint read failed: ${(err as Error)?.message ?? err}`,
      );
      degrade('checkpoints-unavailable');
      return [];
    }
  }

  private resolveFinality(
    checkpoints: EventCheckpoint[],
    snapshot: Awaited<
      ReturnType<BlockchainStateService['getIndexerHealth']>
    > | null,
    degrade: (reason: string) => void,
  ): { safeHeight: string | null; finalizedHeight: string | null } {
    let safeHeight: string | null = null;
    let finalizedHeight: string | null = null;

    for (const checkpoint of checkpoints) {
      const safe = this.toBlockString(checkpoint.lastSafeBlock);
      const finalized = this.toBlockString(checkpoint.lastFinalizedBlock);
      try {
        if (
          safe !== null &&
          (safeHeight === null || BigInt(safe) > BigInt(safeHeight))
        ) {
          safeHeight = safe;
        }
        if (
          finalized !== null &&
          (finalizedHeight === null ||
            BigInt(finalized) > BigInt(finalizedHeight))
        ) {
          finalizedHeight = finalized;
        }
      } catch {
        // Ignore malformed checkpoint rows; they must never break the report.
        continue;
      }
    }

    // Fallback to the live indexer snapshot only when the DB has no usable
    // checkpoint yet. Snapshot uses 0 as "unknown", which carries no finality.
    if (snapshot) {
      if (safeHeight === null && snapshot.safeBlock > 0) {
        safeHeight = String(BigInt(snapshot.safeBlock));
      }
      if (finalizedHeight === null && snapshot.finalizedBlock > 0) {
        finalizedHeight = String(BigInt(snapshot.finalizedBlock));
      }
    }

    if (finalizedHeight === null) degrade('finality-unavailable');
    if (safeHeight === null) degrade('safe-unavailable');
    return { safeHeight, finalizedHeight };
  }

  private computeHeadDistance(
    observedHead: number | null,
    indexedBlock: string | null,
    degrade: (reason: string) => void,
  ): string | null {
    if (observedHead === null || indexedBlock === null) return null;
    try {
      const distance = BigInt(observedHead) - BigInt(indexedBlock);
      return String(distance >= 0n ? distance : 0n);
    } catch {
      degrade('head-distance-unavailable');
      return null;
    }
  }

  /**
   * Normalize a block height from any driver (postgres returns bigint
   * columns as strings, sqlite may return numbers) to a canonical
   * bigint-safe string. Returns null for missing or malformed values.
   */
  private toBlockString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return String(BigInt(Math.trunc(value)));
      }
      if (typeof value === 'string') {
        const text = value.trim();
        if (text === '') return null;
        return String(BigInt(text));
      }
      return null;
    } catch {
      return null;
    }
  }

  private classifyDataState(
    indexedBlock: string | null,
    safeHeight: string | null,
    finalizedHeight: string | null,
  ): DataState {
    if (indexedBlock === null) return DataState.OBSERVED;
    try {
      const indexed = BigInt(indexedBlock);
      if (finalizedHeight !== null && indexed <= BigInt(finalizedHeight)) {
        return DataState.FINALIZED;
      }
      if (safeHeight !== null && indexed <= BigInt(safeHeight)) {
        return DataState.SAFE;
      }
    } catch {
      return DataState.OBSERVED;
    }
    return DataState.OBSERVED;
  }
}
