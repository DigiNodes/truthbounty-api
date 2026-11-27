#!/usr/bin/env node
/**
 * Publish and verify the reviewed OpenAPI + fixture artifacts (#604).
 *
 * The artifacts are generated from the reviewed code by the existing
 * deterministic specs, which rewrite their files only when their UPDATE_*
 * environment variable is set:
 *
 *   src/health/public-status/public-status.artifacts.spec.ts
 *   src/health/public-incidents/public-incidents.artifacts.spec.ts
 *
 * Modes
 *   (default)     Write docs/openapi/manifest.json from the current files.
 *                 No generation, no network, no test run.
 *   --regenerate  Run the generator specs, then write the manifest.
 *   --check       Fail if any recorded checksum no longer matches the file.
 *
 * The manifest is content-derived only (no commit id, no timestamp), so a
 * clean regeneration produces byte-identical output and CI drift checks stay
 * stable. Consumers pin one immutable artifact set by its `sha256` values.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'docs', 'openapi', 'manifest.json');
const MANIFEST_SCHEMA_VERSION = 'openapi-artifacts.v1';

/** Reviewed API surfaces whose OpenAPI document and fixtures are published. */
const ARTIFACT_SETS = [
  {
    schemaVersion: 'public-status.v1',
    spec: 'src/health/public-status/public-status.artifacts.spec.ts',
    updateEnv: 'UPDATE_PUBLIC_STATUS_ARTIFACTS',
    files: [
      'docs/public-status/openapi.json',
      'docs/public-status/fixtures.json',
    ],
  },
  {
    schemaVersion: 'public-incidents.v1',
    spec: 'src/health/public-incidents/public-incidents.artifacts.spec.ts',
    updateEnv: 'UPDATE_PUBLIC_INCIDENTS_ARTIFACTS',
    files: [
      'docs/public-incidents/openapi.json',
      'docs/public-incidents/fixtures.json',
    ],
  },
];

/** Endpoints that must never be published in an artifact. */
const FORBIDDEN_SUBSTRINGS = ['localhost', '127.0.0.1', '0.0.0.0'];

const sha256 = (buffer) =>
  createHash('sha256').update(buffer).digest('hex');

function fail(message) {
  console.error(`openapi:publish — ${message}`);
  process.exit(1);
}

function describeArtifacts() {
  const entries = [];
  for (const set of ARTIFACT_SETS) {
    for (const path of set.files) {
      const absolute = join(ROOT, path);
      if (!existsSync(absolute)) {
        fail(`missing artifact ${path}; run with --regenerate`);
      }
      const bytes = readFileSync(absolute);
      const text = bytes.toString('utf8');

      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        if (text.includes(forbidden)) {
          fail(`${path} contains the forbidden endpoint "${forbidden}"`);
        }
      }
      try {
        JSON.parse(text);
      } catch {
        fail(`${path} is not valid JSON`);
      }

      entries.push({
        path,
        schemaVersion: set.schemaVersion,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }
  return entries;
}

function buildManifest(entries) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    artifacts: entries,
  };
}

function regenerate() {
  for (const set of ARTIFACT_SETS) {
    console.log(`openapi:publish — regenerating ${set.schemaVersion}`);
    const result = spawnSync(
      'npx',
      ['jest', '--runInBand', '--silent', set.spec],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, [set.updateEnv]: '1' },
      },
    );
    if (result.status !== 0) {
      fail(`artifact generation failed for ${set.spec}`);
    }
  }
}

function publish() {
  const manifest = buildManifest(describeArtifacts());
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `openapi:publish — wrote ${manifest.artifacts.length} artifact(s) to docs/openapi/manifest.json`,
  );
  for (const artifact of manifest.artifacts) {
    console.log(`  ${artifact.sha256}  ${artifact.path}`);
  }
}

function check() {
  if (!existsSync(MANIFEST_PATH)) {
    fail('docs/openapi/manifest.json is missing; run npm run openapi:publish');
  }

  const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (committed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      `manifest schema ${committed.schemaVersion} is not ${MANIFEST_SCHEMA_VERSION}`,
    );
  }

  const expected = new Map(
    (committed.artifacts ?? []).map((artifact) => [
      artifact.path,
      artifact.sha256,
    ]),
  );

  const drift = [];
  for (const artifact of describeArtifacts()) {
    if (expected.get(artifact.path) !== artifact.sha256) {
      drift.push(artifact.path);
    }
  }

  if (drift.length > 0) {
    fail(
      `artifact drift detected; regenerate and republish:\n  ${drift.join('\n  ')}`,
    );
  }

  console.log(
    `openapi:check — ${expected.size} artifact checksum(s) match the manifest`,
  );
}

const args = new Set(process.argv.slice(2));
if (args.has('--check')) {
  check();
} else {
  if (args.has('--regenerate')) {
    regenerate();
  }
  publish();
}
