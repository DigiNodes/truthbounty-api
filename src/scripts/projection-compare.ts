#!/usr/bin/env node
/**
 * CLI: Compare projection digests between rebuild and live environments (PREWAVE-BE-039).
 *
 * Usage examples:
 *   ts-node src/scripts/projection-compare.ts --rebuild rebuild-report.json --live live-report.json
 *   ts-node src/scripts/projection-compare.ts --rebuild rebuild-report.json --live live-report.json --format json
 *   ts-node src/scripts/projection-compare.ts --help
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  compareProjectionDigests,
  MissingProjectionDigestError,
  ProjectionBindingMismatchError,
  ProjectionDigestMismatchError,
} from '../v2/replay/projection-digest';
import {
  ProjectionComparisonReport,
  ProjectionDigest,
  ReplayReport,
} from '../v2/replay/projection-rebuild.types';

function parseArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadDigestsFromFile(filePath: string): ProjectionDigest[] {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);

  // Support either full ReplayReport or array of ProjectionDigest
  if (Array.isArray(parsed)) {
    return parsed as ProjectionDigest[];
  }
  if (parsed && Array.isArray((parsed as ReplayReport).digests)) {
    return (parsed as ReplayReport).digests;
  }
  if (parsed && parsed.projector && parsed.digest) {
    return [parsed as ProjectionDigest];
  }
  throw new Error(
    `Invalid digest file format in ${filePath}. Expected ReplayReport or ProjectionDigest array.`,
  );
}

export async function runCompare(args: {
  rebuildFile?: string;
  liveFile?: string;
  format?: 'json' | 'pretty';
  allowExtra?: boolean;
  verifyBinding?: boolean;
}): Promise<{ report: ProjectionComparisonReport; exitCode: number }> {
  if (!args.rebuildFile || !args.liveFile) {
    throw new Error('Both --rebuild and --live file arguments are required.');
  }

  const rebuildDigests = loadDigestsFromFile(args.rebuildFile);
  const liveDigests = loadDigestsFromFile(args.liveFile);

  try {
    const report = compareProjectionDigests(rebuildDigests, liveDigests, {
      failClosed: false,
      verifyBinding: args.verifyBinding !== false,
      allowExtraInRebuild: args.allowExtra === true,
    });

    const exitCode = report.equivalent ? 0 : 1;
    return { report, exitCode };
  } catch (err: unknown) {
    if (
      err instanceof MissingProjectionDigestError ||
      err instanceof ProjectionDigestMismatchError ||
      err instanceof ProjectionBindingMismatchError
    ) {
      console.error(`[ERROR] ${err.name} (${err.code}): ${err.message}`);
      console.error(`Actionable advice: ${err.actionableAdvice}`);
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  if (hasFlag('help') || process.argv.length <= 2) {
    console.log(`
TruthBounty Projection Compare CLI (PREWAVE-BE-039)
Usage: ts-node src/scripts/projection-compare.ts [options]

Options:
  --rebuild <file>         Path to rebuild run report or digests JSON
  --live <file>            Path to live environment report or digests JSON
  --format <json|pretty>   Output format (default: pretty)
  --allow-extra            Allow extra projectors in rebuild without failing
  --no-binding-check       Skip checking release and chain ID equality
  --help                   Display this help message
`);
    process.exit(0);
  }

  const rebuildFile = parseArg('rebuild');
  const liveFile = parseArg('live');
  const format = (parseArg('format', 'pretty') || 'pretty') as 'json' | 'pretty';
  const allowExtra = hasFlag('allow-extra');
  const verifyBinding = !hasFlag('no-binding-check');

  try {
    const { report, exitCode } = await runCompare({
      rebuildFile,
      liveFile,
      format,
      allowExtra,
      verifyBinding,
    });

    if (format === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      console.log('='.repeat(70));
      console.log('TruthBounty Projection Cross-Environment Comparison Report');
      console.log('='.repeat(70));
      console.log(`Timestamp:        ${report.comparedAt}`);
      console.log(`Rebuild Schema:   ${report.rebuildSchema}`);
      console.log(`Live Schema:      ${report.liveSchema}`);
      console.log(`Total Projectors: ${report.projectorsCount}`);
      console.log(`Result:           ${report.equivalent ? 'EQUIVALENT (MATCH)' : 'DRIFT DETECTED (MISMATCH)'}`);
      console.log('-'.repeat(70));

      for (const diff of report.diffs) {
        const icon = diff.status === 'match' ? '✔' : '✖';
        console.log(
          ` ${icon} [${diff.status.toUpperCase()}] Projector: ${diff.projector}`,
        );
        if (diff.status !== 'match') {
          console.log(`   Rebuild: digest=${diff.rebuildDigest ?? 'N/A'}, rows=${diff.rebuildRowCount ?? 'N/A'}`);
          console.log(`   Live:    digest=${diff.liveDigest ?? 'N/A'}, rows=${diff.liveRowCount ?? 'N/A'}`);
          if (diff.details) {
            console.log(`   Details: ${diff.details}`);
          }
        }
      }

      if (report.errors.length) {
        console.log('-'.repeat(70));
        console.log('Actionable Errors:');
        for (const err of report.errors) {
          console.log(`  - ${err}`);
        }
      }
      console.log('='.repeat(70));
    }

    process.exit(exitCode);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
