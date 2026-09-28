import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  RebuildCheckpoint,
  ProjectionRebuildCounter,
  RebuildStatus,
  canonicalEventIdentity,
  emptyCounter,
  foldDigest,
  initialDigest,
  serializeCheckpoint,
} from './rebuild-checkpoint';
import {
  PROJECTION_REGISTRY,
  ProjectorRunSummary,
  RebuildableProjection,
} from './projection-registry';
import {
  ProjectionRebuildRun,
  checkpointColumns,
} from './entities/projection-rebuild-run.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';

/** Default event batch handed to each projector per drain iteration. */
const DEFAULT_EVENT_BATCH = 500;

export interface ProjectionRebuildOptions {
  chainId: number;
  /**
   * The block the deployment began at. Everything strictly before it is out of
   * scope for the read models, so the rebuild starts here rather than at
   * genesis. A string, because a deployment block is a 256-bit quantity that
   * must not pass through a JS `number`.
   */
  deploymentBlock: string;
  /** Events per projector per drain iteration. */
  eventBatchSize?: number;
  /**
   * Stop after this many drain iterations and persist a resumable checkpoint.
   * `null` (the default) drains to completion.
   */
  maxBatches?: number | null;
  /**
   * Clear every registered projection's tables and its cursor before starting.
   * Required for a from-scratch rebuild; the guard below additionally requires
   * an out-of-band shadow target unless `allowInPlace` is set.
   */
  resetProjections?: boolean;
  /**
   * Resume from a previous run's checkpoint instead of starting at
   * `deploymentBlock`.
   *
   * The **whole** checkpoint is required, not just a block and a digest,
   * because the report describes the rebuild as a whole: counters and
   * per-projection breakdowns are carried forward and added to, so a resumed
   * run's report is directly comparable to an uninterrupted one. Resuming with
   * only a block would produce a report covering just the final leg.
   */
  resumeFrom?: RebuildCheckpoint | null;
  /**
   * Acknowledge rebuilding the **live** schema. Without this the service
   * refuses to run against the schema it is connected to, so a half-rebuilt
   * read model can never be observed as authoritative. See §"Cutover safety"
   * in `docs/PROJECTION_REBUILD.md`.
   */
  allowInPlace?: boolean;
}

/**
 * Deterministic, resumable, idempotent rebuild of every V2 read model from the
 * persisted canonical event log (V2-BE-019).
 *
 * ## Scope, stated honestly
 *
 * This rebuilds the **V2 read models from `v2_canonical_events`**, starting at
 * a configured deployment block. It does not re-scan the chain. The canonical
 * event log is itself produced by the ingestion path
 * (`CanonicalEventsService.ingest`), and re-fetching it from RPC is a separate
 * concern that `docs/indexer-runbook.md` already scopes to the indexer
 * ("projections are rebuildable from raw, persisted events"). A rebuild into a
 * genuinely empty schema therefore requires the canonical log to be populated
 * first; the exact procedure is in `docs/PROJECTION_REBUILD.md`.
 *
 * ## Determinism
 *
 * Projections are drained in a fixed registry order until every one reports
 * `processed === 0`. Within each iteration the canonical events in the newly
 * covered block range are folded — in `(blockNumber, logIndex)` order, which is
 * the protocol's own order — into a rolling SHA-256. Same deployment block plus
 * same events yields the same digest, regardless of batch size or where the run
 * was interrupted. See `rebuild-checkpoint.ts`.
 *
 * ## Idempotency and replay-safety
 *
 * Idempotency is inherited from the projectors, not reimplemented here. Each
 * already guards writes with a unique constraint on `(eventTxHash,
 * eventLogIndex)` and treats a violation as either a safe replay or a recorded
 * anomaly. Re-running a completed rebuild therefore reads the same events,
 * applies nothing, and produces a report whose per-projection `applied` counts
 * are zero — which is itself the checkable proof that the first run was
 * complete.
 *
 * ## Cutover safety
 *
 * The service never performs a cutover. It refuses to start against the live
 * schema unless the operator explicitly passes `allowInPlace`, and it reports
 * `safeToCutover` rather than acting on it. The swap is a deliberate,
 * documented operator step (see `docs/PROJECTION_REBUILD.md`); the worst
 * outcome of a half-finished rebuild here is a shadow database that is wrong,
 * never a live one.
 */
@Injectable()
export class ProjectionRebuildService {
  private readonly logger = new Logger(ProjectionRebuildService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PROJECTION_REGISTRY)
    private readonly registry: RebuildableProjection[],
  ) {}

  /**
   * Run (or resume) a rebuild. Returns the deterministic checkpoint; a durable
   * audit row is written for the run.
   */
  async rebuild(
    options: ProjectionRebuildOptions,
  ): Promise<RebuildCheckpoint> {
    const eventBatchSize = options.eventBatchSize ?? DEFAULT_EVENT_BATCH;
    this.assertParsableDeploymentBlock(options.deploymentBlock);
    this.assertShadowTarget(options);

    const runRepo = this.dataSource.getRepository(ProjectionRebuildRun);
    const run = await runRepo.save(
      runRepo.create({
        chainId: options.chainId,
        status: 'running' satisfies RebuildStatus,
        targetSchema: options.allowInPlace ? null : this.describeTargetSchema(),
        deploymentBlock: options.deploymentBlock,
        fromBlock: options.deploymentBlock,
        toBlock: null,
        inputDigest: initialDigest(),
        batchesProcessed: 0,
        eventsConsumed: 0,
        eventsApplied: 0,
        eventsSkipped: 0,
        anomalies: 0,
        safeToCutover: false,
        checkpointJson: '',
        error: null,
        finishedAt: null,
      }),
    );

    try {
      if (options.resumeFrom) {
        // A resumed run inherits the cursors the interrupted run left behind.
        // Touching them here would rewind the drain and double-fold the digest.
        this.logger.log(
          `Resuming rebuild from block ${options.resumeFrom.fromBlock} ` +
            `(carried digest ${options.resumeFrom.inputDigest})`,
        );
      } else {
        if (options.resetProjections) {
          await this.resetProjections();
        }
        await this.seedCursor(options.deploymentBlock);
      }

      const checkpoint = await this.drain(run, options, eventBatchSize);
      const status: RebuildStatus = checkpoint.complete
        ? 'completed'
        : 'aborted';
      await this.persistCheckpoint(run.id, checkpoint, status, null);
      this.logger.log(
        `Rebuild ${run.id} ${status}: ${checkpoint.eventsConsumed} events, ` +
          `digest ${checkpoint.inputDigest}`,
      );
      return checkpoint;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runRepo.update(run.id, { status: 'failed', error: message.slice(0, 2000) });
      throw err;
    }
  }

  /** Serialise a checkpoint for byte-comparison between two runs. */
  render(checkpoint: RebuildCheckpoint): string {
    return serializeCheckpoint(checkpoint);
  }

  /** Most recent run rows, newest first, for operator inspection. */
  async recentRuns(limit = 20): Promise<ProjectionRebuildRun[]> {
    return this.dataSource
      .getRepository(ProjectionRebuildRun)
      .find({ order: { startedAt: 'DESC' }, take: limit });
  }

  // ─── Drain loop ─────────────────────────────────────────────────────────

  private async drain(
    run: ProjectionRebuildRun,
    options: ProjectionRebuildOptions,
    eventBatchSize: number,
  ): Promise<RebuildCheckpoint> {
    const deploymentBlock = BigInt(options.deploymentBlock);
    const prior = options.resumeFrom ?? null;
    /** First block not yet folded into `digest`. */
    let nextBlockToFold = prior
      ? BigInt(prior.fromBlock)
      : deploymentBlock;
    let digest = prior ? prior.inputDigest : initialDigest();

    // Counters carry forward across a resume, so the final report describes the
    // rebuild as a whole and is directly comparable to an uninterrupted run.
    let eventsConsumed = prior?.eventsConsumed ?? 0;
    let eventsApplied = prior?.eventsApplied ?? 0;
    let eventsSkipped = prior?.eventsSkipped ?? 0;
    let anomalies = prior?.anomalies ?? 0;
    let unclaimedEvents = prior?.unclaimedEvents ?? 0;
    let batchesProcessed = prior?.batchesProcessed ?? 0;
    let complete = false;
    let lastCursor: { blockNumber: bigint; logIndex: number } | null = null;

    const perProjection: Record<string, ProjectionRebuildCounter> = {};
    for (const projection of this.registry) {
      perProjection[projection.name] = { ...emptyCounter() };
    }
    if (prior) {
      for (const [name, counter] of Object.entries(prior.perProjection)) {
        if (perProjection[name]) {
          perProjection[name] = { ...counter };
        } else {
          // A projection that was registered for the interrupted run but is not
          // in the registry now. Carried forward rather than dropped, so the
          // two reports remain comparable — and surfaced in the log, because
          // it means the registry changed mid-rebuild.
          perProjection[name] = { ...counter };
          this.logger.warn(
            `Resumed checkpoint references unknown projection ${name}; its ` +
              'counters are carried forward unchanged',
          );
        }
      }
    }

    for (;;) {
      const summaries: ProjectorRunSummary[] = [];
      for (const projection of this.registry) {
        summaries.push(await projection.run(eventBatchSize));
      }

      const drained = summaries.every((summary) => summary.processed === 0);
      const cursor = await this.highestCursor();

      if (cursor) {
        // Fold the newly covered range exactly once. The projectors consume in
        // strict (blockNumber, logIndex) order and each iteration runs every
        // projection to exhaustion, so successive ranges are disjoint and
        // together cover [nextBlockToFold, cursor.blockNumber].
        if (cursor.blockNumber >= nextBlockToFold) {
          const slice = await this.readSlice(
            options.chainId,
            nextBlockToFold,
            cursor.blockNumber,
          );
          digest = foldDigest(
            digest,
            slice.map(canonicalEventIdentity),
          );
          eventsConsumed += slice.length;
          unclaimedEvents += this.countUnclaimed(slice);
          nextBlockToFold = cursor.blockNumber + 1n;
        } else if (!drained) {
          // A projection reported work but no cursor moved. That is a real
          // stall — a projector consuming events without advancing would
          // otherwise spin here forever — so abort loudly rather than loop.
          throw new Error(
            `Rebuild stalled: projectors reported work but no cursor advanced past ` +
              `block ${(nextBlockToFold - 1n).toString()}. Refusing to loop.`,
          );
        }
        lastCursor = cursor;
      }

      for (let i = 0; i < this.registry.length; i += 1) {
        const projection = this.registry[i];
        const summary = summaries[i];
        const counter = perProjection[projection.name];
        counter.eventsConsumed += summary.processed;
        counter.eventsApplied += summary.applied;
        counter.eventsSkipped += summary.processed - summary.applied;
        counter.anomalies += summary.anomalies ?? 0;
        eventsApplied += summary.applied;
        eventsSkipped += summary.processed - summary.applied;
        anomalies += summary.anomalies ?? 0;
      }

      batchesProcessed += 1;

      if (drained) {
        complete = true;
        break;
      }

      // Checkpoint after every non-final iteration: this is what makes a long
      // rebuild resumable, and it is also the earliest point at which a crash
      // leaves an auditable record of how far the run had got.
      await this.persistCheckpoint(
        run.id,
        this.buildCheckpoint(
          options,
          nextBlockToFold,
          lastCursor,
          digest,
          eventsConsumed,
          eventsApplied,
          eventsSkipped,
          anomalies,
          unclaimedEvents,
          batchesProcessed,
          perProjection,
          false,
        ),
        'running',
        null,
      );

      if (
        options.maxBatches !== null &&
        options.maxBatches !== undefined &&
        batchesProcessed >= options.maxBatches
      ) {
        this.logger.warn(
          `Rebuild ${run.id} stopped after ${batchesProcessed} batches at block ` +
            `${lastCursor?.blockNumber.toString() ?? 'unknown'}`,
        );
        break;
      }
    }

    for (const projection of this.registry) {
      perProjection[projection.name].rowsInTable = await projection.countRows();
    }

    return this.buildCheckpoint(
      options,
      nextBlockToFold,
      lastCursor,
      digest,
      eventsConsumed,
      eventsApplied,
      eventsSkipped,
      anomalies,
      unclaimedEvents,
      batchesProcessed,
      perProjection,
      complete,
    );
  }

  // ─── Guards ─────────────────────────────────────────────────────────────

  /**
   * Refuse to start a rebuild against the live schema unless the operator has
   * said so explicitly.
   *
   * The point is not ceremony: a rebuild truncates and re-derives every read
   * model. If it is interrupted, the live schema is left holding a partially
   * rebuilt projection that looks authoritative to every reader. Requiring an
   * explicit acknowledgement makes that a decision rather than an accident.
   */
  private assertShadowTarget(options: ProjectionRebuildOptions): void {
    if (options.allowInPlace) {
      this.logger.warn(
        'Rebuild running IN PLACE against the live schema. A partial rebuild is ' +
          'observable to readers until the run completes. Prefer a shadow schema.',
      );
      return;
    }
    const schema = process.env.REBUILD_SCHEMA?.trim();
    if (!schema) {
      throw new BadRequestException(
        'Refusing to rebuild without a shadow target. Set REBUILD_SCHEMA to the ' +
          'shadow schema/namespace to rebuild into, or pass allowInPlace: true to ' +
          'accept that a partial rebuild will be observable on the live schema. ' +
          'See docs/PROJECTION_REBUILD.md.',
      );
    }
    this.logger.log(`Rebuild target schema: ${schema}`);
  }

  private describeTargetSchema(): string | null {
    const schema = process.env.REBUILD_SCHEMA?.trim();
    return schema && schema.length > 0 ? schema : null;
  }

  private assertParsableDeploymentBlock(deploymentBlock: string): void {
    if (!/^\d+$/.test(deploymentBlock.trim())) {
      throw new BadRequestException(
        `deploymentBlock must be a base-10 integer string, received ${JSON.stringify(deploymentBlock)}`,
      );
    }
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────

  /**
   * Clear every registered projection's tables and the shared projector cursor.
   *
   * Only reachable against a shadow target unless `allowInPlace` was set — the
   * guard above runs first.
   */
  private async resetProjections(): Promise<void> {
    for (const projection of this.registry) {
      await projection.reset();
    }
    await this.dataSource.getRepository(ProjectorCursor).clear();
    this.logger.log(
      `Reset ${this.registry.length} projections and the shared projector cursor`,
    );
  }

  /**
   * Park every projector cursor at `(deploymentBlock - 1, -1)`.
   *
   * This is the whole trick for "start from a configured deployment block"
   * without touching a single projector: each projector resumes via
   * `CanonicalEventQueryService.findAfter(after)`, whose predicate is
   * `blockNumber > after.blockNumber OR (blockNumber = after.blockNumber AND
   * logIndex > after.logIndex)`. Feeding it `deploymentBlock - 1 / -1` therefore
   * yields exactly the events at or after `deploymentBlock`, and no earlier.
   * It reuses the projectors' own, already-tested resumption path rather than
   * introducing a second one.
   *
   * The upsert matters as much as the value: a projector that finds **no**
   * cursor row passes `after = null` to `findAfter`, which means *genesis*, not
   * the deployment block. Simply updating existing rows would therefore leave a
   * fresh or reset schema scanning the entire chain.
   */
  private async seedCursor(deploymentBlock: string): Promise<void> {
    const cursorRepo = this.dataSource.getRepository(ProjectorCursor);
    // Drop any cursor left behind by a projector that is no longer registered,
    // so a stale row cannot make the drain think it is already past a block.
    await cursorRepo.clear();

    const preceding = (BigInt(deploymentBlock) - 1n).toString();
    for (const projection of this.registry) {
      await cursorRepo.upsert(
        {
          projectorName: projection.projectorName,
          lastBlockNumber: preceding,
          lastLogIndex: -1,
        },
        ['projectorName'],
      );
    }
    this.logger.log(
      `Parked ${this.registry.length} projector cursors at block ${preceding}`,
    );
  }

  /**
   * The furthest point any projector cursor has reached, as an exact
   * `(blockNumber, logIndex)` pair so a resumed run can pick up from precisely
   * where this one stopped rather than re-scanning the block.
   */
  private async highestCursor(): Promise<{
    blockNumber: bigint;
    logIndex: number;
  } | null> {
    const cursors = await this.dataSource.getRepository(ProjectorCursor).find();
    let highest: { blockNumber: bigint; logIndex: number } | null = null;
    for (const cursor of cursors) {
      const blockNumber = BigInt(cursor.lastBlockNumber);
      if (
        highest === null ||
        blockNumber > highest.blockNumber ||
        (blockNumber === highest.blockNumber && cursor.lastLogIndex > highest.logIndex)
      ) {
        highest = { blockNumber, logIndex: cursor.lastLogIndex };
      }
    }
    return highest;
  }

  /**
   * Read the canonical events in `[fromBlock, toBlock]` in protocol order.
   * `blockNumber` is a `bigint` column, so the bounds are passed as strings and
   * compared as bigints — never as JS numbers.
   */
  private async readSlice(
    chainId: number,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<CanonicalEvent[]> {
    const repo: Repository<CanonicalEvent> =
      this.dataSource.getRepository(CanonicalEvent);
    return repo
      .createQueryBuilder('e')
      .where('e.chainId = :chainId', { chainId })
      .andWhere('e.blockNumber >= :fromBlock', {
        fromBlock: fromBlock.toString(),
      })
      .andWhere('e.blockNumber <= :toBlock', {
        toBlock: toBlock.toString(),
      })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .getMany();
  }

  /** Canonical events in the slice that no registered projection claims. */
  private countUnclaimed(slice: CanonicalEvent[]): number {
    const claimed = new Set<string>();
    for (const projection of this.registry) {
      for (const name of projection.eventNames) claimed.add(name);
    }
    return slice.filter((event) => !claimed.has(event.eventName)).length;
  }

  private async persistCheckpoint(
    runId: string,
    checkpoint: RebuildCheckpoint,
    status: RebuildStatus,
    error: string | null,
  ): Promise<void> {
    await this.dataSource.getRepository(ProjectionRebuildRun).update(runId, {
      ...checkpointColumns(checkpoint, status),
      error,
      finishedAt: status === 'running' ? null : new Date(),
    });
  }

  private buildCheckpoint(
    options: ProjectionRebuildOptions,
    nextBlockToFold: bigint,
    lastCursor: { blockNumber: bigint; logIndex: number } | null,
    inputDigest: string,
    eventsConsumed: number,
    eventsApplied: number,
    eventsSkipped: number,
    anomalies: number,
    unclaimedEvents: number,
    batchesProcessed: number,
    perProjection: Record<string, ProjectionRebuildCounter>,
    complete: boolean,
  ): RebuildCheckpoint {
    return {
      chainId: options.chainId,
      deploymentBlock: options.deploymentBlock,
      // Resume semantics: `fromBlock` is the first block *not yet folded*, so
      // handing it back as `resumeFrom.fromBlock` continues the digest fold
      // without double-counting or skipping a single canonical event.
      fromBlock: nextBlockToFold.toString(),
      toBlock: lastCursor ? lastCursor.blockNumber.toString() : null,
      logIndex: lastCursor ? lastCursor.logIndex : -1,
      batchesProcessed,
      eventsConsumed,
      eventsApplied,
      eventsSkipped,
      anomalies,
      unclaimedEvents,
      inputDigest,
      perProjection,
      // A rebuild is only cutover-eligible when it drained to completion, left
      // no anomaly behind, and accounted for every canonical event. A
      // non-zero `unclaimedEvents` means the registry is stale, and swapping in
      // a projection that is missing a whole read model is exactly the silent
      // data loss this pipeline exists to prevent.
      safeToCutover: complete && anomalies === 0 && unclaimedEvents === 0,
      complete,
    };
  }
}
