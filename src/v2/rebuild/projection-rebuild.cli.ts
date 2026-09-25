import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { readFileSync } from 'fs';
import { dataSource } from '../../config/data-source';
import { RebuildCheckpoint } from './rebuild-checkpoint';
import { ProjectionRebuildService } from './projection-rebuild.service';
import { ProjectionRebuildModule } from './v2-rebuild.module';

/**
 * Operator entry point for a projection rebuild.
 *
 * This is a standalone script, not an HTTP endpoint, on purpose: a rebuild
 * truncates and re-derives every read model. Exposing it over HTTP would put a
 * destructive, long-running, cluster-wide operation behind a request that any
 * authenticated caller could repeat. An operator runs it deliberately, in a
 * shell, against a database they have chosen.
 *
 * ## Usage
 *
 * ```bash
 * # Shadow rebuild (the normal case) — set REBUILD_SCHEMA first
 * REBUILD_SCHEMA=truthbounty_shadow \
 *   npx ts-node src/v2/rebuild/projection-rebuild.cli.ts \
 *   --chain-id 10 --deployment-block 126000000 --reset
 *
 * # Stop early and keep a resumable checkpoint
 *   ... --max-batches 200 > partial.json
 *
 * # Resume from that checkpoint file
 *   ... --resume-from partial.json > final.json
 *
 * # Deliberately rebuild the live schema (discouraged; see docs)
 *   ... --allow-in-place
 * ```
 *
 * The script prints the deterministic checkpoint as JSON on stdout and logs to
 * stderr, so the report can be piped straight into `jq` or `diff`:
 *
 * ```bash
 * diff <(jq -S . run-a.json) <(jq -S . run-b.json)   # must be empty
 * ```
 */

interface CliArgs {
  chainId: number;
  deploymentBlock: string;
  eventBatchSize?: number;
  maxBatches: number | null;
  reset: boolean;
  resumeFromFile?: string;
  allowInPlace: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      raw[key] = 'true';
    } else {
      raw[key] = next;
      i += 1;
    }
  }

  if (!raw['chain-id']) {
    throw new Error('--chain-id is required');
  }
  if (!raw['deployment-block']) {
    throw new Error('--deployment-block is required');
  }

  return {
    chainId: Number(raw['chain-id']),
    // Kept as a string all the way into the service: a block number is a
    // 256-bit quantity and must never be parsed into a JS number.
    deploymentBlock: raw['deployment-block'],
    eventBatchSize: raw['event-batch-size']
      ? Number(raw['event-batch-size'])
      : undefined,
    maxBatches: raw['max-batches'] ? Number(raw['max-batches']) : null,
    reset: raw['reset'] === 'true',
    resumeFromFile: raw['resume-from'],
    allowInPlace: raw['allow-in-place'] === 'true',
  };
}

/**
 * Load a previous run's checkpoint.
 *
 * The whole checkpoint is needed, not just a block and a digest: the counters
 * and per-projection breakdowns carry forward so a resumed report describes the
 * rebuild as a whole. Resuming from a hand-picked subset of fields would
 * silently produce a report that only covers the final leg.
 */
function loadCheckpoint(path: string): RebuildCheckpoint {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} does not contain a checkpoint object`);
  }
  const checkpoint = parsed as Partial<RebuildCheckpoint>;
  for (const field of ['fromBlock', 'inputDigest'] as const) {
    if (typeof checkpoint[field] !== 'string') {
      throw new Error(`${path} is missing required checkpoint field "${field}"`);
    }
  }
  return checkpoint as RebuildCheckpoint;
}

/**
 * Composition root for the CLI. It reuses the application's own
 * `DataSource` options rather than re-deriving them, so the rebuild connects
 * to exactly the database the migrations were applied to — no second, drifting
 * copy of the connection configuration.
 */
@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), ProjectionRebuildModule],
})
class ProjectionRebuildCliModule {}

async function main(): Promise<void> {
  const logger = new Logger('ProjectionRebuildCli');
  const args = parseArgs(process.argv.slice(2));

  if (args.resumeFromFile && args.reset) {
    throw new Error(
      '--reset and --resume-from are mutually exclusive: --reset clears the ' +
        'projections, which would discard the very state the resume point ' +
        'refers to',
    );
  }

  const app = await NestFactory.createApplicationContext(
    ProjectionRebuildCliModule,
    { logger: ['error', 'warn', 'log'] },
  );

  try {
    const service = app.get(ProjectionRebuildService);
    const checkpoint = await service.rebuild({
      chainId: args.chainId,
      deploymentBlock: args.deploymentBlock,
      eventBatchSize: args.eventBatchSize,
      maxBatches: args.maxBatches,
      resetProjections: args.reset,
      resumeFrom: args.resumeFromFile
        ? loadCheckpoint(args.resumeFromFile)
        : null,
      allowInPlace: args.allowInPlace,
    });

    // stdout is the report; keep it clean so it can be piped.
    process.stdout.write(`${service.render(checkpoint)}\n`);

    if (!checkpoint.safeToCutover) {
      logger.error(
        'Rebuild is NOT safe to cut over. Do not swap the read model. ' +
          `complete=${checkpoint.complete} anomalies=${checkpoint.anomalies} ` +
          `unclaimedEvents=${checkpoint.unclaimedEvents}`,
      );
      process.exitCode = 2;
    } else {
      logger.log(
        'Rebuild complete and safe to cut over. Follow the swap procedure in ' +
          'docs/PROJECTION_REBUILD.md (this script never performs it).',
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
