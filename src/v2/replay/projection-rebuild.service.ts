import { Injectable } from '@nestjs/common';
import { digestProjector } from './projection-digest';
import {
  CanonicalEventLike,
  ProjectorAdapter,
  ProjectionDigest,
  RebuildMode,
  ReplayBinding,
  ReplayCheckpoint,
  ReplayReport,
} from './projection-rebuild.types';

const SECRET_KEY_RE =
  /(private|secret|mnemonic|password|authorization|signature|evidence|token)/i;

export interface RebuildOptions {
  mode: RebuildMode;
  binding: ReplayBinding;
  /** Isolated target label; production names are rejected unless allowed. */
  targetSchema: string;
  batchSize?: number;
  maxBatches?: number | null;
  /** Required for cutover into a protected schema. */
  confirmCutover?: boolean;
  /** Existing checkpoint for resume. */
  checkpoint?: ReplayCheckpoint | null;
  /** Baseline digests for verify/cutover. */
  expectedDigests?: { projector: string; digest: string; rowCount: number }[];
  /** Fail closed if RPC/event source is marked unavailable. */
  rpcAvailable?: boolean;
}

export interface EventSource {
  /**
   * Stream events from deploymentBlock upward, ordered by (blockNumber, logIndex).
   * After checkpoint, only events strictly after the cursor are returned.
   */
  readFrom(
    binding: ReplayBinding,
    after: ReplayCheckpoint | null,
    limit: number,
  ): Promise<CanonicalEventLike[]>;
}

function assertSafeReportValue(key: string, value: unknown): void {
  if (SECRET_KEY_RE.test(key)) {
    throw new Error(`refusing to include protected field in report: ${key}`);
  }
  if (typeof value === 'string' && /0x[a-fA-F0-9]{64}/.test(value) && /sig|key/i.test(key)) {
    throw new Error(`refusing secret-like value for ${key}`);
  }
}

@Injectable()
export class ProjectionRebuildService {
  constructor(
    private readonly eventSource: EventSource,
    private readonly projectors: ProjectorAdapter[],
  ) {}

  async run(options: RebuildOptions): Promise<ReplayReport> {
    const startedAt = new Date().toISOString();
    const errors: string[] = [];
    const notes: string[] = [];
    const batchSize = options.batchSize ?? 100;
    const dryRun = options.mode === 'dry-run' || options.mode === 'verify';

    if (options.rpcAvailable === false) {
      return this.finish(options, startedAt, {
        eventsRead: 0,
        eventsApplied: 0,
        eventsSkipped: 0,
        checkpoint: options.checkpoint ?? null,
        digests: [],
        digestsMatch: null,
        cutoverApplied: false,
        errors: ['RPC unavailable — fail closed'],
        notes: [],
        dryRun,
        resumable: true,
      });
    }

    if (!options.binding.chainId || options.binding.deploymentBlock < 0) {
      errors.push('invalid binding: chainId/deploymentBlock');
    }
    if (!options.binding.releaseId || !options.binding.artifactChecksum) {
      errors.push('invalid binding: releaseId/artifactChecksum required');
    }
    if (this.isProtectedSchema(options.targetSchema) && options.mode === 'rebuild') {
      errors.push(
        'refusing rebuild against protected production schema without cutover flow',
      );
    }
    if (options.mode === 'cutover') {
      if (!options.confirmCutover) {
        errors.push('cutover requires explicit confirmCutover=true');
      }
      if (!options.expectedDigests?.length) {
        errors.push('cutover requires expectedDigests');
      }
    }
    if (errors.length) {
      return this.finish(options, startedAt, {
        eventsRead: 0,
        eventsApplied: 0,
        eventsSkipped: 0,
        checkpoint: options.checkpoint ?? null,
        digests: [],
        digestsMatch: false,
        cutoverApplied: false,
        errors,
        notes,
        dryRun,
        resumable: true,
      });
    }

    let checkpoint = options.checkpoint ?? null;
    if (options.mode === 'rebuild' && !checkpoint) {
      for (const p of this.projectors) {
        if (p.reset && !dryRun) await p.reset();
      }
      notes.push('rebuild from deployment block with empty projector state');
    }

    let eventsRead = 0;
    let eventsApplied = 0;
    let eventsSkipped = 0;
    let batchesProcessed = 0;

    // Bounded batches until source returns fewer than batchSize
    for (;;) {
      if (
        options.maxBatches !== undefined &&
        options.maxBatches !== null &&
        batchesProcessed >= options.maxBatches
      ) {
        break;
      }

      let batch: CanonicalEventLike[];
      try {
        batch = await this.eventSource.readFrom(
          options.binding,
          checkpoint,
          batchSize,
        );
      } catch (e) {
        errors.push(
          `event source error: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        break;
      }

      if (!batch.length) break;
      eventsRead += batch.length;

      for (const event of batch) {
        if (event.chainId !== options.binding.chainId) {
          errors.push(
            `chain mismatch at ${event.txHash}:${event.logIndex} — fail closed`,
          );
          return this.finish(options, startedAt, {
            eventsRead,
            eventsApplied,
            eventsSkipped,
            checkpoint,
            digests: await this.computeDigests(options),
            digestsMatch: false,
            cutoverApplied: false,
            errors,
            notes,
            dryRun,
            resumable: true,
          });
        }
        if (!event.eventName || event.txHash?.length !== 66) {
          errors.push(
            `malformed event ${event.id ?? 'unknown'} — fail closed`,
          );
          continue;
        }

        if (dryRun) {
          eventsSkipped += 1;
        } else {
          for (const projector of this.projectors) {
            const result = await projector.apply(event);
            if (result === 'applied') eventsApplied += 1;
            else eventsSkipped += 1;
          }
        }

        checkpoint = {
          chainId: options.binding.chainId,
          lastBlockNumber: String(event.blockNumber),
          lastLogIndex: event.logIndex,
          lastEventId: event.id,
          updatedAt: new Date().toISOString(),
        };
      }

      batchesProcessed += 1;
      if (
        options.maxBatches !== undefined &&
        options.maxBatches !== null &&
        batchesProcessed >= options.maxBatches
      ) {
        break;
      }

      if (batch.length < batchSize) break;
    }

    const digests = await this.computeDigests(options);
    let digestsMatch: boolean | null = null;
    let cutoverApplied = false;

    if (
      (options.mode === 'verify' || options.mode === 'cutover') &&
      options.expectedDigests
    ) {
      digestsMatch = options.expectedDigests.every((exp) => {
        const got = digests.find((d) => d.projector === exp.projector);
        return (
          !!got &&
          got.digest === exp.digest &&
          got.rowCount === exp.rowCount
        );
      });
      if (!digestsMatch) {
        errors.push('projection digests do not match expected — refuse cutover');
      }
    }

    if (
      options.mode === 'cutover' &&
      digestsMatch &&
      options.confirmCutover &&
      !dryRun
    ) {
      cutoverApplied = true;
      notes.push('cutover applied after matching digests and explicit confirm');
    }

    for (const d of digests) {
      assertSafeReportValue('digest', d.digest);
    }

    return this.finish(options, startedAt, {
      eventsRead,
      eventsApplied,
      eventsSkipped,
      checkpoint,
      digests,
      digestsMatch,
      cutoverApplied,
      errors,
      notes,
      dryRun,
      resumable: true,
    });
  }

  private isProtectedSchema(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'public' || n === 'production' || n === 'prod';
  }

  private async computeDigests(
    options?: RebuildOptions,
  ): Promise<ProjectionDigest[]> {
    const out: ProjectionDigest[] = [];
    for (const p of this.projectors) {
      out.push(
        await digestProjector(p.name, await p.snapshot(), {
          schema: options?.targetSchema,
          releaseId: options?.binding?.releaseId,
          chainId: options?.binding?.chainId,
          deploymentBlock: options?.binding?.deploymentBlock,
          artifactChecksum: options?.binding?.artifactChecksum,
        }),
      );
    }
    return out;
  }

  private finish(
    options: RebuildOptions,
    startedAt: string,
    partial: Omit<ReplayReport, 'schemaVersion' | 'mode' | 'binding' | 'startedAt' | 'finishedAt'>,
  ): ReplayReport {
    return {
      schemaVersion: 1,
      mode: options.mode,
      binding: options.binding,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...partial,
    };
  }
}
