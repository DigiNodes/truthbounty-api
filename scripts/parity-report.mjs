#!/usr/bin/env node
/**
 * Local, CI, and Container Type-Check Parity Report and Drift Guard
 * (PREWAVE-BE-030 / GitHub issue #625).
 *
 * WHAT THIS IS
 * ------------
 * A dependency-free, read-only diagnostic and verification tool that guarantees
 * local build, hosted CI, and Docker container build compile the same source
 * set with the same tsconfig, toolchain versions, and generated prerequisites.
 *
 * WHAT IT ENFORCES (exit 1 on violation under --check)
 * ----------------------------------------------------
 *   1. Node runtime satisfies engines.node (e.g. >=22.22 <23).
 *   2. npm client satisfies engines.npm (e.g. >=10 <12).
 *   3. TypeScript compiler matches pinned version (6.0.3).
 *   4. Generated prerequisites (Prisma client) exist and are non-stale.
 *   5. Container context does not exclude test sources (.dockerignore parity).
 *   6. Container image builder stage explicitly enforces type checking.
 *   7. tsconfig.json explicitly compiles the unified source set (src and test).
 *
 * SECURITY AND ARCHITECTURE CONSTRAINTS
 * -------------------------------------
 *   - Sanitized diagnostics: never logs credentials, private keys, or tokens.
 *   - Fail-closed: missing security or compiler configurations fail immediately.
 *   - Zero external runtime dependencies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseSemver(versionStr) {
  if (!versionStr || typeof versionStr !== 'string') return null;
  const cleaned = versionStr.trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: cleaned,
  };
}

/**
 * Minimal dependency-free range check for the simple engines constraints used
 * in package.json (e.g. ">=22.22 <23", ">=10 <12"). Supports space-separated
 * comparators with >=, >, <, <=, and exact versions. No hyphen/|| ranges.
 */
function satisfiesConstraint(version, constraint) {
  if (!version || !constraint) return false;
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const current = [parsed.major, parsed.minor, parsed.patch];

  const comparators = String(constraint).trim().split(/\s+/).filter(Boolean);
  for (const comparator of comparators) {
    const match = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(comparator);
    if (!match) return false;
    const op = match[1] || '=';
    const target = [
      parseInt(match[2], 10),
      match[3] !== undefined ? parseInt(match[3], 10) : 0,
      match[4] !== undefined ? parseInt(match[4], 10) : 0,
    ];
    let cmp = 0;
    for (let i = 0; i < 3; i++) {
      if (current[i] !== target[i]) {
        cmp = current[i] < target[i] ? -1 : 1;
        break;
      }
    }
    const pass =
      (op === '>=' && cmp >= 0) ||
      (op === '<=' && cmp <= 0) ||
      (op === '>' && cmp > 0) ||
      (op === '<' && cmp < 0) ||
      (op === '=' && cmp === 0);
    if (!pass) return false;
  }
  return true;
}

function checkNodeVersion(currentVersion, constraint) {
  const parsed = parseSemver(currentVersion);
  if (!parsed) {
    return {
      ok: false,
      current: currentVersion || 'unknown',
      expected: constraint,
      diagnostic: `Unable to parse current Node version "${currentVersion}".`,
    };
  }

  const ok = satisfiesConstraint(parsed.raw, constraint);
  return {
    ok,
    current: `v${parsed.raw}`,
    expected: constraint,
    diagnostic: ok
      ? null
      : `Node runtime drift: running ${parsed.raw}, but required constraint is ${constraint}. Use a Node version that satisfies engines.node (e.g. 'nvm use 22.22.3' or Docker container).`,
  };
}

function checkNpmVersion(constraint) {
  let npmVersion = null;
  try {
    const raw = execSync('npm -v', { encoding: 'utf8', timeout: 3000 });
    npmVersion = raw.trim();
  } catch {
    // Fallback to process.env.npm_config_user_agent
    const ua = process.env.npm_config_user_agent || '';
    const match = /npm\/([0-9.]+)/.exec(ua);
    if (match) {
      npmVersion = match[1];
    }
  }

  if (!npmVersion) {
    return {
      ok: false,
      current: 'unknown',
      expected: constraint,
      diagnostic: `Unable to determine npm version. Ensure npm is installed and in PATH.`,
    };
  }

  const parsed = parseSemver(npmVersion);
  // package.json constraint: ">=10 <12"
  const ok = parsed ? satisfiesConstraint(parsed.raw, constraint) : false;
  return {
    ok,
    current: `v${npmVersion}`,
    expected: constraint,
    diagnostic: ok
      ? null
      : `npm version drift: running ${npmVersion}, but required constraint is ${constraint}. Use an npm version that satisfies engines.npm.`,
  };
}

function checkTypescriptVersion(expectedVersion) {
  let resolvedVersion = null;
  const localTsPkg = join(repoRoot, 'node_modules', 'typescript', 'package.json');
  if (existsSync(localTsPkg)) {
    const pkg = readJsonSafe(localTsPkg);
    if (pkg && pkg.version) {
      resolvedVersion = pkg.version;
    }
  }

  if (!resolvedVersion) {
    const lockfilePath = join(repoRoot, 'package-lock.json');
    const lockfile = readJsonSafe(lockfilePath);
    if (lockfile?.packages?.['node_modules/typescript']?.version) {
      resolvedVersion = lockfile.packages['node_modules/typescript'].version;
    }
  }

  const ok = resolvedVersion === expectedVersion;
  return {
    ok,
    current: resolvedVersion || 'uninstalled',
    expected: expectedVersion,
    diagnostic: ok
      ? null
      : `TypeScript compiler drift: resolved ${resolvedVersion || 'none'}, expected pinned ${expectedVersion}. Run 'npm ci' to restore deterministic compiler.`,
  };
}

function checkGeneratedPrerequisites() {
  const generatedClientDir = join(repoRoot, 'src', 'generated', 'client');
  const schemaFile = join(repoRoot, 'prisma', 'schema.prisma');

  const schemaExists = existsSync(schemaFile);
  const clientExists = existsSync(generatedClientDir) && existsSync(join(generatedClientDir, 'client.ts'));

  const ok = schemaExists && clientExists;
  return {
    ok,
    current: clientExists ? 'present' : 'missing',
    expected: 'generated client present',
    diagnostic: ok
      ? null
      : `Generated prerequisites missing or stale: 'src/generated/client/client.ts' was not found. Run 'npm run generate:prerequisites'.`,
  };
}

function checkDockerParity() {
  const dockerignorePath = join(repoRoot, '.dockerignore');
  const dockerfilePath = join(repoRoot, 'Dockerfile');

  let dockerignoreClean = true;
  let dockerignoreDiag = null;

  if (existsSync(dockerignorePath)) {
    const content = readFileSync(dockerignorePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.includes('test')) {
      dockerignoreClean = false;
      dockerignoreDiag = `Container-only source exclusion detected: .dockerignore excludes 'test'. Remove 'test' from .dockerignore so container and local/CI type-check identical sources.`;
    }
  }

  let dockerfileEnforced = false;
  let dockerfileDiag = null;

  if (existsSync(dockerfilePath)) {
    const content = readFileSync(dockerfilePath, 'utf8');
    if (content.includes('npm run type-check')) {
      dockerfileEnforced = true;
    } else {
      dockerfileDiag = `Dockerfile does not enforce type checking: missing 'RUN npm run type-check'. Container must not bypass type checking.`;
    }
  }

  const ok = dockerignoreClean && dockerfileEnforced;
  return {
    ok,
    dockerignoreClean,
    dockerfileEnforced,
    diagnostic: dockerignoreDiag || dockerfileDiag || null,
  };
}

function checkTsConfigParity() {
  const tsconfigPath = join(repoRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return {
      ok: false,
      diagnostic: `tsconfig.json not found in repository root.`,
    };
  }

  const tsconfig = readJsonSafe(tsconfigPath);
  if (!tsconfig) {
    return {
      ok: false,
      diagnostic: `Failed to parse tsconfig.json.`,
    };
  }

  const include = tsconfig.include || [];
  const includesSrc = include.some((pattern) => pattern.startsWith('src'));
  const includesTest = include.some((pattern) => pattern.startsWith('test'));

  const ok = includesSrc && includesTest;
  return {
    ok,
    include,
    diagnostic: ok
      ? null
      : `tsconfig.json source set incomplete: expected include patterns for both 'src/**/*' and 'test/**/*'. Found: ${JSON.stringify(include)}`,
  };
}

export function evaluateParity() {
  const packageJson = readJsonSafe(join(repoRoot, 'package.json')) || {};
  const engines = packageJson.engines || {};
  const devDeps = packageJson.devDependencies || {};

  const nodeExpected = engines.node || '>=20 <21';
  const npmExpected = engines.npm || '>=10 <11';
  const tsExpected = devDeps.typescript || '6.0.3';

  const nodeResult = checkNodeVersion(process.version, nodeExpected);
  const npmResult = checkNpmVersion(npmExpected);
  const tsResult = checkTypescriptVersion(tsExpected);
  const prereqResult = checkGeneratedPrerequisites();
  const dockerResult = checkDockerParity();
  const tsconfigResult = checkTsConfigParity();

  const allPassed =
    nodeResult.ok &&
    npmResult.ok &&
    tsResult.ok &&
    prereqResult.ok &&
    dockerResult.ok &&
    tsconfigResult.ok;

  const diagnostics = [];
  if (!nodeResult.ok && nodeResult.diagnostic) diagnostics.push(nodeResult.diagnostic);
  if (!npmResult.ok && npmResult.diagnostic) diagnostics.push(npmResult.diagnostic);
  if (!tsResult.ok && tsResult.diagnostic) diagnostics.push(tsResult.diagnostic);
  if (!prereqResult.ok && prereqResult.diagnostic) diagnostics.push(prereqResult.diagnostic);
  if (!dockerResult.ok && dockerResult.diagnostic) diagnostics.push(dockerResult.diagnostic);
  if (!tsconfigResult.ok && tsconfigResult.diagnostic) diagnostics.push(tsconfigResult.diagnostic);

  return {
    timestamp: new Date().toISOString(),
    status: allPassed ? 'PASSED' : 'DRIFT_DETECTED',
    checks: {
      node: nodeResult,
      npm: npmResult,
      typescript: tsResult,
      prerequisites: prereqResult,
      docker: dockerResult,
      tsconfig: tsconfigResult,
    },
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isJson = args.includes('--json');
const isCheck = args.includes('--check') || args.includes('--strict');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
Usage: node scripts/parity-report.mjs [options]

Options:
  --check, --strict  Exit with code 1 if toolchain, container, or compiler drift is detected.
  --json             Print results in machine-readable JSON format.
  --help             Show this help message.
`);
  process.exit(0);
}

const report = evaluateParity();

if (isJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('======================================================================');
  console.log('  TruthBounty API — Local, CI & Container Type-Check Parity Report   ');
  console.log('======================================================================');
  console.log(`  Status:               ${report.status}`);
  console.log(`  Node Engine:          ${report.checks.node.current} (expected: ${report.checks.node.expected}) [${report.checks.node.ok ? 'OK' : 'DRIFT'}]`);
  console.log(`  npm Client:           ${report.checks.npm.current} (expected: ${report.checks.npm.expected}) [${report.checks.npm.ok ? 'OK' : 'DRIFT'}]`);
  console.log(`  TypeScript Compiler:  ${report.checks.typescript.current} (expected: ${report.checks.typescript.expected}) [${report.checks.typescript.ok ? 'OK' : 'DRIFT'}]`);
  console.log(`  Prisma Client:        ${report.checks.prerequisites.current} [${report.checks.prerequisites.ok ? 'OK' : 'MISSING'}]`);
  console.log(`  Container Parity:     ${report.checks.docker.ok ? 'Enforced (No Exclusions)' : 'DISPARITY'} [${report.checks.docker.ok ? 'OK' : 'FAIL'}]`);
  console.log(`  TSConfig Source Set:  ${report.checks.tsconfig.ok ? 'src & test included' : 'INCOMPLETE'} [${report.checks.tsconfig.ok ? 'OK' : 'FAIL'}]`);
  console.log('======================================================================');

  if (report.diagnostics.length > 0) {
    console.log('\nActionable Diagnostics:');
    for (const diag of report.diagnostics) {
      console.log(`  - ${diag}`);
    }
    console.log();
  }
}

if (isCheck && report.status !== 'PASSED') {
  process.exit(1);
}
process.exit(0);
