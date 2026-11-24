import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runDependencyAudit } from './dependency-audit.mjs';

const commit = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;

function createFixture(t, auditStatus, vulnerabilities) {
  const cwd = mkdtempSync(join(tmpdir(), 'dependency-audit-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}\n');

  const sbom = {
    bomFormat: 'CycloneDX',
    components: [{ name: 'fixture-package', version: '1.0.0' }],
    metadata: { credentials: 'not-a-real-secret' },
  };
  const audit = {
    auditReportVersion: 2,
    vulnerabilities,
    authorization: 'Bearer private-token-value',
  };
  const spawn = (_command, args, options) => {
    if (args[0] === '--version') {
      return { status: 0, stdout: '10.8.0\n', stderr: '' };
    }
    if (args[0] === 'sbom') {
      return { status: 0, stdout: JSON.stringify(sbom), stderr: '' };
    }
    if (args[0] === 'audit') {
      assert.equal(options.env.npm_config_loglevel, 'silent');
      return {
        status: auditStatus,
        stdout: JSON.stringify(audit),
        stderr: '',
      };
    }
    assert.fail(`Unexpected npm command: ${args.join(' ')}`);
  };
  const status = runDependencyAudit({
    cwd,
    env: {
      GITHUB_SHA: commit,
      CONTAINER_IMAGE_DIGEST: imageDigest,
    },
    spawn,
    logger: { error() {} },
  });

  return { cwd, status };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('vulnerable fixture fails audit but generates uploadable SBOM and sanitized evidence', (t) => {
  const { cwd, status } = createFixture(t, 1, {
    fixturePackage: { severity: 'high' },
  });
  const artifacts = join(cwd, 'artifacts');
  const sbom = readFileSync(join(artifacts, 'dependency-sbom.cdx.json'));
  const reportText = readFileSync(join(artifacts, 'npm-audit-report.json'), 'utf8');
  const metadata = JSON.parse(
    readFileSync(join(artifacts, 'security-scan-metadata.json'), 'utf8'),
  );
  const checksums = JSON.parse(
    readFileSync(join(artifacts, 'artifact-checksums.json'), 'utf8'),
  );

  assert.equal(status, 1);
  assert.equal(JSON.parse(sbom.toString()).bomFormat, 'CycloneDX');
  assert.equal(JSON.parse(reportText).vulnerabilities.fixturePackage.severity, 'high');
  assert.doesNotMatch(reportText, /private-token-value|not-a-real-secret|Bearer/);
  assert.equal(metadata.commit, commit);
  assert.equal(metadata.containerImageDigest, imageDigest);
  assert.equal(metadata.lockfileSha256, digest(readFileSync(join(cwd, 'package-lock.json'))));
  assert.equal(metadata.nodeVersion, process.version);
  assert.equal(metadata.npmVersion, '10.8.0');
  assert.equal(metadata.sbomSha256, digest(sbom));
  assert.equal(metadata.auditReportSha256, digest(reportText));
  assert.equal(checksums['dependency-sbom.cdx.json'], digest(sbom));
  assert.equal(checksums['npm-audit-report.json'], digest(reportText));
  assert.equal(
    checksums['security-scan-metadata.json'],
    digest(readFileSync(join(artifacts, 'security-scan-metadata.json'))),
  );
});

test('clean fixture passes audit and generates both reports', (t) => {
  const { cwd, status } = createFixture(t, 0, {});
  const artifacts = join(cwd, 'artifacts');

  assert.equal(status, 0);
  assert.equal(
    JSON.parse(readFileSync(join(artifacts, 'dependency-sbom.cdx.json'), 'utf8')).bomFormat,
    'CycloneDX',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(artifacts, 'npm-audit-report.json'), 'utf8')).vulnerabilities,
    {},
  );
});

test('security evidence uploads are commit-unique and retained for 90 days', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );

  assert.match(
    workflow,
    /- name: Upload immutable dependency security evidence\s+if: always\(\)[\s\S]*?name: dependency-security-evidence-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90/,
  );
  assert.match(
    workflow,
    /- name: Upload immutable container scan evidence\s+if: always\(\)[\s\S]*?name: container-scan-evidence-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90/,
  );
  assert.match(workflow, /--arg containerImageDigest "\$CONTAINER_IMAGE_DIGEST"/);
});
