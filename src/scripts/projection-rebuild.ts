/**
 * CLI: deterministic projection rebuild (PREWAVE-BE-002).
 *
 * Usage examples:
 *   ts-node src/scripts/projection-rebuild.ts --mode dry-run
 *   ts-node src/scripts/projection-rebuild.ts --mode verify
 *
 * Does not print secrets. Wire real EventSource/projectors in app bootstrap later.
 */
import { ProjectionRebuildService } from '../v2/replay/projection-rebuild.service';
import { RebuildMode, ReplayBinding } from '../v2/replay/projection-rebuild.types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main() {
  const mode = (arg('mode', 'dry-run') || 'dry-run') as RebuildMode;
  const binding: ReplayBinding = {
    chainId: Number(arg('chainId', '11155420')),
    releaseId: arg('releaseId', 'unset')!,
    deploymentBlock: Number(arg('deploymentBlock', '0')),
    artifactChecksum: arg('artifactChecksum', 'unset')!,
  };

  // Placeholder empty adapters — integration wires real projectors.
  const service = new ProjectionRebuildService(
    { async readFrom() { return []; } },
    [],
  );

  let expectedDigests: { projector: string; digest: string; rowCount: number }[] | undefined;
  const expectedFile = arg('expectedDigestsFile') || arg('expected-digests');
  if (expectedFile) {
    const fs = await import('fs');
    const path = await import('path');
    const raw = fs.readFileSync(path.resolve(process.cwd(), expectedFile), 'utf8');
    const parsed = JSON.parse(raw);
    expectedDigests = Array.isArray(parsed)
      ? parsed
      : (parsed as { digests?: { projector: string; digest: string; rowCount: number }[] }).digests;
  }

  const runMode = mode === 'compare' ? 'verify' : mode;

  const report = await service.run({
    mode: runMode,
    binding,
    targetSchema: arg('targetSchema', 'replay_shadow')!,
    confirmCutover: process.argv.includes('--confirm-cutover'),
    rpcAvailable: !process.argv.includes('--rpc-down'),
    expectedDigests,
  });

  if (mode === 'compare') {
    report.mode = 'compare';
  }

  // Auditable report only (already secret-safe by construction).
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'fatal');
  process.exit(1);
});
