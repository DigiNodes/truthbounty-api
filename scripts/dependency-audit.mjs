import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const artifactDirectory = join(process.cwd(), 'artifacts');
const artifactPath = join(artifactDirectory, 'dependency-sbom.cdx.json');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

mkdirSync(artifactDirectory, { recursive: true });

const sbom = spawnSync(
  npmCommand,
  ['sbom', '--sbom-format', 'cyclonedx', '--omit=dev'],
  { encoding: 'utf8' },
);

if (sbom.error || sbom.status !== 0) {
  console.error('Dependency SBOM generation failed.');
  if (sbom.error) console.error(sbom.error.message);
  process.exit(sbom.status ?? 1);
}

try {
  const document = JSON.parse(sbom.stdout);
  if (document.bomFormat !== 'CycloneDX' || !Array.isArray(document.components)) {
    throw new Error('SBOM is not a valid CycloneDX document.');
  }
  writeFileSync(artifactPath, `${JSON.stringify(document, null, 2)}\n`);
} catch (error) {
  console.error(`Dependency SBOM validation failed: ${error.message}`);
  process.exit(1);
}

const audit = spawnSync(npmCommand, ['audit', '--audit-level=high'], {
  stdio: 'inherit',
});

if (audit.error) {
  console.error(`Dependency audit failed: ${audit.error.message}`);
  process.exit(1);
}

process.exit(audit.status ?? 1);