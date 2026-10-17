import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runCompare } from '../src/scripts/projection-compare';
import { ProjectionDigest } from '../src/v2/replay/projection-rebuild.types';

describe('Projection Compare CLI & Command (PREWAVE-BE-039)', () => {
  const tmpDir = path.resolve(__dirname, '../node_modules/.tmp-compare-test');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const matchingRebuild: ProjectionDigest[] = [
    {
      projector: 'claims',
      rowCount: 10,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      schema: 'replay_shadow',
      releaseId: 'v2.1.0',
      chainId: 11155420,
    },
    {
      projector: 'disputes',
      rowCount: 5,
      digest: 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123',
      schema: 'replay_shadow',
      releaseId: 'v2.1.0',
      chainId: 11155420,
    },
  ];

  const matchingLive: ProjectionDigest[] = [
    {
      projector: 'claims',
      rowCount: 10,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      schema: 'public',
      releaseId: 'v2.1.0',
      chainId: 11155420,
    },
    {
      projector: 'disputes',
      rowCount: 5,
      digest: 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123',
      schema: 'public',
      releaseId: 'v2.1.0',
      chainId: 11155420,
    },
  ];

  it('reports matching equivalence between rebuild and live report files', async () => {
    const rebuildFile = path.join(tmpDir, 'rebuild-ok.json');
    const liveFile = path.join(tmpDir, 'live-ok.json');

    fs.writeFileSync(rebuildFile, JSON.stringify(matchingRebuild, null, 2));
    fs.writeFileSync(liveFile, JSON.stringify(matchingLive, null, 2));

    const { report, exitCode } = await runCompare({
      rebuildFile,
      liveFile,
      format: 'json',
    });

    expect(exitCode).toBe(0);
    expect(report.equivalent).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.diffs.every((d) => d.status === 'match')).toBe(true);
  });

  it('detects drift and exits with code 1 when digests mismatch', async () => {
    const rebuildFile = path.join(tmpDir, 'rebuild-ok.json');
    const liveDriftFile = path.join(tmpDir, 'live-drift.json');

    const driftedLive: ProjectionDigest[] = [
      ...matchingLive.slice(0, 1),
      {
        ...matchingLive[1],
        digest: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // drifted!
      },
    ];

    fs.writeFileSync(liveDriftFile, JSON.stringify(driftedLive, null, 2));

    const { report, exitCode } = await runCompare({
      rebuildFile,
      liveFile: liveDriftFile,
      format: 'json',
    });

    expect(exitCode).toBe(1);
    expect(report.equivalent).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    const disputeDiff = report.diffs.find((d) => d.projector === 'disputes');
    expect(disputeDiff?.status).toBe('mismatch');
  });

  it('detects missing projectors and reports actionable advice', async () => {
    const partialRebuild: ProjectionDigest[] = [matchingRebuild[0]]; // missing 'disputes'
    const rebuildPartialFile = path.join(tmpDir, 'rebuild-partial.json');
    const liveFile = path.join(tmpDir, 'live-ok.json');

    fs.writeFileSync(rebuildPartialFile, JSON.stringify(partialRebuild, null, 2));

    const { report, exitCode } = await runCompare({
      rebuildFile: rebuildPartialFile,
      liveFile,
      format: 'json',
    });

    expect(exitCode).toBe(1);
    expect(report.equivalent).toBe(false);
    const disputesDiff = report.diffs.find((d) => d.projector === 'disputes');
    expect(disputesDiff?.status).toBe('missing_in_rebuild');
    expect(disputesDiff?.details).toContain('rebuilt');
  });

  it('executes CLI binary with --help flag successfully', () => {
    const output = execSync('npx ts-node src/scripts/projection-compare.ts --help', {
      encoding: 'utf8',
    });
    expect(output).toContain('TruthBounty Projection Compare CLI');
    expect(output).toContain('--rebuild');
    expect(output).toContain('--live');
  });

  it('executes CLI binary comparing two files with JSON output', () => {
    const rebuildFile = path.join(tmpDir, 'rebuild-ok.json');
    const liveFile = path.join(tmpDir, 'live-ok.json');

    const output = execSync(
      `npx ts-node src/scripts/projection-compare.ts --rebuild ${rebuildFile} --live ${liveFile} --format json`,
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(output);
    expect(parsed.equivalent).toBe(true);
    expect(parsed.diffs).toHaveLength(2);
  });
});
