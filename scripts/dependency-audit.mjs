import { createHash } from 'node:crypto';
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sensitiveKey = /token|password|authorization|credential|secret|signature/i;
const authUrl = /(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const npmToken = /(_authToken\s*[=:]\s*)[^\s"'`]+/gi;
const bearerToken = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const npmAccessToken = /\bnpm_[A-Za-z0-9]{20,}\b/g;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sanitize(value, key = '') {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(authUrl, '$1[REDACTED]@')
    .replace(npmToken, '$1[REDACTED]')
    .replace(bearerToken, '$1[REDACTED]')
    .replace(npmAccessToken, '[REDACTED]');
}

function runNpm(spawn, command, args, cwd, env, jsonOutput = false) {
  return spawn(command, args, {
    cwd,
    encoding: 'utf8',
    env: jsonOutput ? { ...env, npm_config_loglevel: 'silent' } : env,
  });
}

export function runDependencyAudit({
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  command = npmCommand,
  logger = console,
} = {}) {
  const artifacts = join(cwd, 'artifacts');
  const sbomPath = join(artifacts, 'dependency-sbom.cdx.json');
  const auditPath = join(artifacts, 'npm-audit-report.json');
  const metadataPath = join(artifacts, 'security-scan-metadata.json');
  const checksumsPath = join(artifacts, 'artifact-checksums.json');
  let failed = false;
  let sbomBytes;
  let auditBytes;

  try {
    mkdirSync(artifacts, { recursive: true });
    for (const path of [sbomPath, auditPath, metadataPath, checksumsPath]) {
      rmSync(path, { force: true });
    }
    const lockfileSha256 = sha256(readFileSync(join(cwd, 'package-lock.json')));
    const imageDigest = env.CONTAINER_IMAGE_DIGEST;
    const commit = env.GITHUB_SHA;
    if (!commit || !/^[a-f0-9]{40,64}$/i.test(commit)) {
      throw new Error('Reviewed commit SHA is missing or invalid.');
    }
    if (!imageDigest || !/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) {
      throw new Error('Container image digest is missing or invalid.');
    }

    const nodeVersion = process.version;
    const npmVersionResult = runNpm(spawn, command, ['--version'], cwd, env);
    const npmVersion = (npmVersionResult.stdout || '').trim();
    if (npmVersionResult.error || npmVersionResult.status !== 0 || !npmVersion) {
      failed = true;
    }

    const sbom = runNpm(
      spawn,
      command,
      ['sbom', '--sbom-format', 'cyclonedx', '--omit=dev'],
      cwd,
      env,
    );
    if (sbom.error || sbom.status !== 0) {
      failed = true;
    } else {
      try {
        const document = JSON.parse(sbom.stdout);
        if (document.bomFormat !== 'CycloneDX' || !Array.isArray(document.components)) {
          throw new Error('Invalid CycloneDX SBOM.');
        }
        sbomBytes = Buffer.from(`${JSON.stringify(sanitize(document), null, 2)}\n`);
        writeFileSync(sbomPath, sbomBytes);
      } catch {
        failed = true;
      }
    }

    const audit = runNpm(
      spawn,
      command,
      ['audit', '--audit-level=high', '--json'],
      cwd,
      env,
      true,
    );
    if (audit.error || audit.status !== 0) failed = true;
    try {
      const report = JSON.parse(audit.stdout || '');
      auditBytes = Buffer.from(`${JSON.stringify(sanitize(report), null, 2)}\n`);
    } catch {
      auditBytes = Buffer.from(
        `${JSON.stringify(
          { error: 'Audit report unavailable or invalid', exitCode: audit.status ?? 1 },
          null,
          2,
        )}\n`,
      );
      failed = true;
    }
    writeFileSync(auditPath, auditBytes);

    if (sbomBytes) {
      const metadata = {
        commit,
        lockfileSha256,
        nodeVersion,
        npmVersion,
        containerImageDigest: imageDigest,
        sbomSha256: sha256(sbomBytes),
        auditReportSha256: sha256(auditBytes),
      };
      const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
      writeFileSync(metadataPath, metadataBytes);
      const checksums = {
        'dependency-sbom.cdx.json': sha256(sbomBytes),
        'npm-audit-report.json': sha256(auditBytes),
        'security-scan-metadata.json': sha256(metadataBytes),
      };
      writeFileSync(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`);
    } else {
      failed = true;
    }
  } catch (error) {
    failed = true;
    logger.error(
      error.message === 'Reviewed commit SHA is missing or invalid.' ||
        error.message === 'Container image digest is missing or invalid.'
        ? error.message
        : 'Dependency security evidence generation failed.',
    );
  }

  if (failed) {
    logger.error('Dependency security scan failed; see the uploaded evidence artifact.');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runDependencyAudit();
}
