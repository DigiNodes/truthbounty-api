#!/usr/bin/env node
/**
 * NestJS baseline guard (STAB-BE-001 / GitHub issue #515).
 *
 * WHAT THIS IS
 * ------------
 * A dependency-free, read-only check that the `@nestjs/*` dependency set in
 * this repository is internally consistent, so that a fresh `npm ci` on the
 * supported Node/npm toolchain resolves without `--force` / `--legacy-peer-deps`.
 *
 * It exists because the runtime/testing major split described in #515 was real
 * on `main` between commits 500bcc2 and 2c4918c and was closed as a side effect
 * of an unrelated feature commit. Nothing in the tree prevented dependabot from
 * reintroducing it. See docs/NESTJS_BASELINE.md.
 *
 * WHAT IT ENFORCES (exit 1 on violation)
 * ---------------------------------------
 *   1. Every framework-core `@nestjs/*` package (@nestjs/common, @nestjs/core,
 *      @nestjs/platform-*, @nestjs/microservices, @nestjs/websockets) declares a
 *      single-comparator range that pins a concrete major, and all of them agree
 *      on that major.
 *   2. `@nestjs/testing` declares a concrete major AND that major equals the
 *      framework-core major. This is the exact condition that produced the
 *      reported ERESOLVE failure: `@nestjs/testing@12.x` declares peer
 *      `@nestjs/common ^12.0.0` / `@nestjs/core ^12.0.0`, so pairing it with a
 *      runtime on 11 is a peer-range conflict, not a style preference.
 *   3. Where a lockfile is present, the `peerDependencies` recorded in
 *      `package-lock.json` for `@nestjs/testing` actually admit the resolved
 *      version of every installed `@nestjs/*` peer.
 *   4. `@nestjs/testing`, `@nestjs/cli` and `@nestjs/schematics` are declared as
 *      devDependencies. Shipping test/build tooling in a production image is a
 *      supply-chain and image-size problem, and it makes the baseline ambiguous.
 *   5. All four of @nestjs/common, @nestjs/core, @nestjs/platform-express and
 *      @nestjs/testing are present at all. Deleting @nestjs/testing to "make the
 *      mismatch go away" is a regression, not a fix.
 *
 * WHAT IT DELIBERATELY DOES NOT ENFORCE
 * -------------------------------------
 *   * `@nestjs/cli` / `@nestjs/schematics` majors. These are build tooling, not
 *     runtime. The lockfile shows `@nestjs/cli@12.0.1` declares peer
 *     dependencies only on build-tool packages (webpack, ts-loader,
 *     fork-ts-checker-webpack-plugin, @swc/cli, ...), all optional, and none on
 *     @nestjs/common or @nestjs/core. A major ahead of runtime is therefore a
 *     legitimate, supported configuration and is reported informationally.
 *   * Satellite integration majors by default. Packages like @nestjs/config,
 *     @nestjs/schedule, @nestjs/axios, @nestjs/throttler, @nestjs/swagger and
 *     @nestjs/typeorm each have their own release cadence and their own
 *     supported range of NestJS majors; the lockfile shows @nestjs/throttler@6
 *     accepting NestJS 7 through 11, for example. Forcing them to equal the
 *     framework major would be wrong. They are always reported; under --strict
 *     an unpinned range on any @nestjs/* entry is also a failure.
 *
 * USAGE
 * -----
 *   node scripts/check-nest-baseline.mjs           # enforced checks
 *   node scripts/check-nest-baseline.mjs --strict   # also fail on unpinned satellites
 *   node scripts/check-nest-baseline.mjs --json     # machine-readable result
 *   node scripts/check-nest-baseline.mjs --help
 *
 * EXIT CODES
 * ----------
 *   0  baseline consistent (possibly with non-blocking notices)
 *   1  baseline violated
 *   2  usage error / repository files not readable
 *
 * No dependencies are installed, no network calls are made, and nothing is
 * written. The script only reads package.json and (if present)
 * package-lock.json; it never reads node_modules, so it works on a bare
 * checkout.
 *
 * Wiring this into CI is intentionally out of scope for the change that
 * introduced it (.github/workflows/ci.yml is owned by a separate, concurrent
 * change). The raw `node` command above is the supported invocation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The framework line. These packages are released together and their majors
 * move together; a divergence between any two of them is a real inconsistency.
 */
const FRAMEWORK_CORE = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/platform-fastify',
  '@nestjs/microservices',
  '@nestjs/websockets',
];

/** Framework-coupled but not part of the core release train. */
const TESTING = ['@nestjs/testing'];

/** Build tooling. Reported, never enforced — see the header comment. */
const TOOLING = ['@nestjs/cli', '@nestjs/schematics'];

/** Must exist for the baseline to mean anything at all. */
const REQUIRED = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@nestjs/testing',
];

const CORE_REQUIRED = ['@nestjs/common', '@nestjs/core'];

// ---------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------

/**
 * Accepts only a single-comparator range that pins a concrete major:
 *   11.2.6   ^11.1.12   ~11.1   11.x   11   11.1.2-rc.1   v11.0.0
 * Everything else — `*`, `latest`, `>=11 <12`, URLs, `workspace:`, `npm:`
 * aliases, git refs — is reported as unpinned/unsupported rather than guessed
 * at. Guessing is what makes baseline guards silently wrong.
 */
const SIMPLE_RANGE =
  /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/;
const PREFIXED_RANGE =
  /^[\^~]v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @returns {{major: number|null, reason: string|null}}
 */
function parseMajor(range) {
  if (typeof range !== 'string') {
    return { major: null, reason: 'range is not a string' };
  }
  const trimmed = range.trim();
  if (trimmed === '') {
    return { major: null, reason: 'empty range' };
  }
  if (/^(latest|next|beta|canary|experimental)$/i.test(trimmed)) {
    return { major: null, reason: `dist-tag range "${trimmed}"` };
  }
  if (/(\*|(^|[^.\w])x([^.\w]|$))/i.test(trimmed) && !/^\d+\.[xX*](\.[xX*])?$/.test(trimmed)) {
    return { major: null, reason: `wildcard range "${trimmed}"` };
  }
  if (/(:|\/\/|git|github|file:|link:|workspace:)/i.test(trimmed)) {
    return { major: null, reason: `non-registry range "${trimmed}"` };
  }
  const match = SIMPLE_RANGE.exec(trimmed) ?? PREFIXED_RANGE.exec(trimmed);
  if (!match) {
    return {
      major: null,
      reason: `unsupported range form "${trimmed}" (expected e.g. 11.2.6, ^11.1.12, ~11.1, 11.x)`,
    };
  }
  return { major: Number(match[1]), reason: null };
}

/**
 * Every major admitted by an OR-list of simple ranges, e.g. the peer range
 * "^7.0.0 || ^8.0.0 || ... || ^11.0.0" admits {7,8,9,10,11}. Unparseable
 * alternatives are ignored rather than widening the set to "everything".
 */
function admittedMajors(peerRange) {
  const majors = new Set();
  for (const alternative of String(peerRange).split('||')) {
    const { major } = parseMajor(alternative.trim());
    if (major !== null) majors.add(major);
  }
  return majors;
}

// ---------------------------------------------------------------------------
// Repo reading
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectNestEntries(pkg) {
  const entries = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const block = pkg[field] ?? {};
    for (const name of Object.keys(block).sort()) {
      if (!name.startsWith('@nestjs/')) continue;
      entries.push({ name, range: block[name], field });
    }
  }
  return entries;
}

function roleOf(name) {
  if (FRAMEWORK_CORE.includes(name)) return 'core';
  if (TESTING.includes(name)) return 'testing';
  if (TOOLING.includes(name)) return 'tooling';
  return 'satellite';
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

const findings = [];
function fail(check, message, remedy) {
  findings.push({ level: 'fail', check, message, remedy });
}
function notice(check, message) {
  findings.push({ level: 'notice', check, message, remedy: null });
}
function pass(check, message) {
  findings.push({ level: 'pass', check, message, remedy: null });
}

function describe(entry, lockVersion) {
  const resolved = lockVersion ? `  resolved ${lockVersion}` : '';
  return `${entry.name.padEnd(26)} ${String(entry.range).padEnd(14)}${resolved}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  let strict = false;
  let json = false;

  for (const arg of argv) {
    if (arg === '--strict') strict = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'check-nest-baseline.mjs — NestJS dependency baseline guard (STAB-BE-001 / #515)',
          '',
          'Usage:',
          '  node scripts/check-nest-baseline.mjs [--strict] [--json]',
          '',
          '  --strict  additionally fail when ANY @nestjs/* entry uses a range that',
          '            does not pin a concrete major (today: @nestjs/mapped-types "*")',
          '  --json    emit a machine-readable summary on stdout',
          '  -h,--help show this text',
          '',
          'Exit codes: 0 consistent, 1 baseline violated, 2 usage/repo error.',
          '',
        ].join('\n'),
      );
      return 0;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\nRun with --help.\n`);
      return 2;
    }
  }

  const pkgPath = join(repoRoot, 'package.json');
  const lockPath = join(repoRoot, 'package-lock.json');

  if (!existsSync(pkgPath)) {
    process.stderr.write(`Cannot read ${pkgPath}\n`);
    return 2;
  }

  let pkg;
  let lock = null;
  try {
    pkg = readJson(pkgPath);
  } catch (error) {
    process.stderr.write(`Cannot parse ${pkgPath}: ${error.message}\n`);
    return 2;
  }
  if (existsSync(lockPath)) {
    try {
      lock = readJson(lockPath);
    } catch (error) {
      process.stderr.write(
        `Cannot parse ${lockPath}: ${error.message}\n` +
          `Continuing without lockfile cross-checks; declared-range checks still apply.\n`,
      );
      lock = null;
    }
  }

  const entries = collectNestEntries(pkg);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const lockVersion = (name) => {
    const node = lock?.packages?.[`node_modules/${name}`];
    return node && typeof node.version === 'string' ? node.version : null;
  };
  const lockMajors = new Map();
  for (const entry of entries) {
    const version = lockVersion(entry.name);
    if (version) lockMajors.set(entry.name, parseMajor(version).major);
  }

  // -- Check 5: required packages present ----------------------------------
  for (const name of REQUIRED) {
    if (!byName.has(name)) {
      fail(
        'required-present',
        `${name} is not declared in package.json.`,
        `Restore it. Removing ${name} to dodge a version conflict is a regression, not a fix.`,
      );
    }
  }
  if (findings.length === 0) {
    pass('required-present', `All of ${REQUIRED.join(', ')} are declared.`);
  }

  // -- Parse every declared range ------------------------------------------
  /** @type {Map<string, {major: number|null, reason: string|null}>} */
  const parsed = new Map();
  for (const entry of entries) {
    const result = parseMajor(entry.range);
    parsed.set(entry.name, result);

    const coupled = roleOf(entry.name) === 'core' || roleOf(entry.name) === 'testing';
    if (result.major === null) {
      if (coupled || strict) {
        fail(
          'pinned-major',
          `${entry.name} = "${entry.range}" does not pin a concrete major (${result.reason}).`,
          coupled
            ? `Framework-coupled packages must pin a major, e.g. "^11.1.12".`
            : `Pin a concrete major, or accept the wildcard in writing and run without --strict.`,
        );
      } else {
        notice(
          'pinned-major',
          `${entry.name} = "${entry.range}" does not pin a concrete major (${result.reason}). Not enforced by default; --strict would fail on this.`,
        );
      }
    }
  }

  // -- Check 1: framework core majors are unanimous and pinned -------------
  const coreEntries = entries.filter((e) => FRAMEWORK_CORE.includes(e.name));
  const coreMajors = new Map();
  for (const entry of coreEntries) {
    const { major } = parsed.get(entry.name);
    if (major !== null) coreMajors.set(entry.name, major);
  }
  const distinctCoreMajors = [...new Set(coreMajors.values())];

  if (coreEntries.length === 0) {
    fail(
      'core-alignment',
      'No framework-core @nestjs/* package was found.',
      'Expected at least @nestjs/common and @nestjs/core.',
    );
  } else if (distinctCoreMajors.length === 0) {
    fail(
      'core-alignment',
      'No framework-core @nestjs/* package resolved a pinned major, so alignment cannot be asserted.',
      'Pin the framework-core ranges (^11.1.12 or an exact 11.x.y) and re-run.',
    );
  } else if (distinctCoreMajors.length > 1) {
    fail(
      'core-alignment',
      `Framework-core packages disagree on the major: ${[...coreMajors.entries()]
        .map(([n, m]) => `${n}=${m}`)
        .join(', ')}.`,
      'Align every framework-core @nestjs/* range on a single major before touching anything else.',
    );
  } else {
    pass(
      'core-alignment',
      `Framework-core packages all declare major ${distinctCoreMajors[0]}.`,
    );
  }

  const frameworkMajor = distinctCoreMajors.length === 1 ? distinctCoreMajors[0] : null;

  // -- Check 2: @nestjs/testing major matches the runtime major ------------
  const testingEntry = byName.get('@nestjs/testing');
  if (testingEntry) {
    const { major, reason } = parsed.get('@nestjs/testing');
    if (major === null) {
      fail(
        'testing-alignment',
        `@nestjs/testing = "${testingEntry.range}" does not pin a major (${reason}).`,
        'Pin @nestjs/testing to an exact version on the same major as @nestjs/common/@nestjs/core.',
      );
    } else if (frameworkMajor === null) {
      notice(
        'testing-alignment',
        `@nestjs/testing is on major ${major}, but the framework major could not be established, so alignment is unproven.`,
      );
    } else if (major !== frameworkMajor) {
      fail(
        'testing-alignment',
        `@nestjs/testing is on major ${major} while the runtime is on major ${frameworkMajor}.`,
        `@nestjs/testing@${major}.x declares peer @nestjs/common ^${major}.0.0 and @nestjs/core ^${major}.0.0, ` +
          'so this pair is an unsatisfiable peer set and "npm ci" fails with ERESOLVE. ' +
          `Move @nestjs/testing onto major ${frameworkMajor} (exact pin, not a caret range).`,
      );
    } else {
      pass(
        'testing-alignment',
        `@nestjs/testing is on major ${major}, matching the runtime.`,
      );
    }
  }

  // -- Check 3: lockfile peer ranges admit the resolved peers ---------------
  if (lock) {
    const testingNode = lock.packages?.['node_modules/@nestjs/testing'];
    if (testingNode) {
      const peers = testingNode.peerDependencies ?? {};
      const meta = testingNode.peerDependenciesMeta ?? {};
      let checked = 0;
      let violated = 0;
      for (const [peerName, peerRange] of Object.entries(peers)) {
        if (!peerName.startsWith('@nestjs/')) continue;
        const resolvedMajor = lockMajors.get(peerName);
        if (resolvedMajor === null || resolvedMajor === undefined) {
          if (meta[peerName]?.optional) continue;
          notice(
            'lockfile-peers',
            `@nestjs/testing declares peer ${peerName}@${peerRange} but ${peerName} is not installed; ` +
              'the peer is neither satisfied nor provably violated from the lockfile alone.',
          );
          continue;
        }
        checked += 1;
        const allowed = admittedMajors(peerRange);
        if (allowed.size === 0) {
          notice(
            'lockfile-peers',
            `Could not parse peer range ${peerName}@${peerRange}; skipped.`,
          );
          continue;
        }
        if (!allowed.has(resolvedMajor)) {
          violated += 1;
          fail(
            'lockfile-peers',
            `package-lock.json: @nestjs/testing@${testingNode.version} requires peer ${peerName}@${peerRange} ` +
              `(${[...allowed].sort((a, b) => a - b).join(' | ')}), but the lockfile resolves ${peerName} to major ${resolvedMajor}.`,
            `Regenerate the lockfile after aligning package.json, or set @nestjs/testing to the version whose peer range covers major ${resolvedMajor}.`,
          );
        }
      }
      if (violated === 0 && checked > 0) {
        pass(
          'lockfile-peers',
          `All ${checked} installed @nestjs/* peers satisfy the peer range recorded for @nestjs/testing@${testingNode.version}.`,
        );
      }
    } else {
      notice(
        'lockfile-peers',
        'package-lock.json is present but records no node_modules/@nestjs/testing entry; peer cross-check skipped.',
      );
    }
  } else {
    notice(
      'lockfile-peers',
      'No readable package-lock.json; declared-range checks were applied but resolved peer ranges were not cross-checked.',
    );
  }

  // -- Check 4: tooling is dev-only ----------------------------------------
  const devOnly = [...TESTING, ...TOOLING];
  for (const name of devOnly) {
    const entry = byName.get(name);
    if (entry && entry.field !== 'devDependencies') {
      fail(
        'tooling-placement',
        `${name} is declared under "${entry.field}" instead of "devDependencies".`,
        `Move it to devDependencies so production images do not carry ${name}.`,
      );
    }
  }
  if (!findings.some((f) => f.check === 'tooling-placement' && f.level === 'fail')) {
    pass(
      'tooling-placement',
      `${devOnly.filter((n) => byName.has(n)).join(', ') || 'no tooling entries'} are devDependencies.`,
    );
  }

  // -- Non-blocking observations -------------------------------------------
  for (const entry of entries) {
    if (roleOf(entry.name) !== 'tooling') continue;
    const declared = parsed.get(entry.name).major;
    const resolved = lockMajors.get(entry.name);
    const drift = declared !== null && resolved !== null && declared !== resolved;
    if (drift) {
      notice(
        'tooling-major',
        `${entry.name} is declared "${entry.range}" (major ${declared}) but the lockfile resolves major ${resolved}. ` +
          'Tooling majors are not enforced; this is informational.',
      );
    }
  }

  const satellites = entries.filter((e) => roleOf(e.name) === 'satellite');
  const ahead = satellites.filter((e) => {
    const declared = parsed.get(e.name).major;
    return frameworkMajor !== null && declared !== null && declared > frameworkMajor;
  });
  for (const entry of ahead) {
    notice(
      'satellite-major',
      `${entry.name} is on major ${parsed.get(entry.name).major}, ahead of the framework major ${frameworkMajor}. ` +
        'Satellite packages keep their own cadence; confirm its peer range covers this runtime before upgrading.',
    );
  }

  // -- Verdict --------------------------------------------------------------
  const failures = findings.filter((f) => f.level === 'fail');
  const notices = findings.filter((f) => f.level === 'notice');
  const exitCode = failures.length > 0 ? 1 : 0;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          check: 'nest-baseline',
          packageName: pkg.name ?? null,
          strict,
          frameworkMajor,
          lockfile: lock ? relative(repoRoot, lockPath) : null,
          entries: entries.map((e) => ({
            name: e.name,
            range: e.range,
            field: e.field,
            role: roleOf(e.name),
            declaredMajor: parsed.get(e.name).major,
            unresolvedReason: parsed.get(e.name).reason,
            lockVersion: lockVersion(e.name),
          })),
          findings,
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }

  const out = [];
  out.push('NestJS baseline guard — ' + (pkg.name ?? 'package.json'));
  out.push(`repository : ${repoRoot}`);
  out.push(`lockfile   : ${lock ? 'package-lock.json' : 'not readable'}`);
  out.push(`mode       : ${strict ? 'strict' : 'default'}`);
  out.push('');

  out.push('Framework core (enforced: one shared major)');
  if (coreEntries.length === 0) {
    out.push('  (none declared)');
  }
  for (const entry of coreEntries) {
    out.push('  ' + describe(entry, lockVersion(entry.name)));
  }
  out.push('');

  if (testingEntry) {
    out.push('Testing (enforced: same major as framework core)');
    out.push('  ' + describe(testingEntry, lockVersion('@nestjs/testing')));
    out.push('');
  }

  const toolingEntries = entries.filter((e) => roleOf(e.name) === 'tooling');
  out.push('Dev tooling (reported only — a major ahead of runtime is legitimate)');
  if (toolingEntries.length === 0) {
    out.push('  (none declared)');
  }
  for (const entry of toolingEntries) {
    out.push('  ' + describe(entry, lockVersion(entry.name)));
  }
  out.push('');

  out.push('Satellite integrations (own release cadence; reported)');
  if (satellites.length === 0) {
    out.push('  (none declared)');
  }
  for (const entry of satellites) {
    out.push('  ' + describe(entry, lockVersion(entry.name)));
  }
  out.push('');

  out.push('Checks');
  for (const finding of findings) {
    const tag =
      finding.level === 'fail' ? '[FAIL]' : finding.level === 'pass' ? '[ ok ]' : '[note]';
    out.push(`  ${tag} ${finding.check}: ${finding.message}`);
    if (finding.remedy && finding.level === 'fail') {
      out.push(`         -> ${finding.remedy}`);
    }
  }
  out.push('');

  if (exitCode === 0) {
    out.push(
      `BASELINE CONSISTENT (framework major ${frameworkMajor ?? 'unknown'})` +
        (notices.length > 0
          ? ` — ${notices.length} non-blocking notice(s); none of them is a verification.`
          : '.'),
    );
    out.push(
      'This script checks declared and lockfile-resolved versions only. It does not run ' +
        'npm ci, a typecheck, tests, or a build; those remain unverified here.',
    );
  } else {
    out.push(
      `BASELINE VIOLATED — ${failures.length} blocking finding(s). ` +
        'See docs/NESTJS_BASELINE.md for the rationale and the upgrade/deferral record.',
    );
  }

  process.stdout.write(out.join('\n') + '\n');
  return exitCode;
}

process.exit(main(process.argv.slice(2)));
