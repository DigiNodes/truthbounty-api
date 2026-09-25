# NestJS Baseline and Dependency-Freeze Record

> **Read this first: the failure described in the issue was not reproducible on
> current `main`.** Issue #515 (STAB-BE-001) was filed on the premise that
> `@nestjs/testing` sat on major 12 while the NestJS runtime sat on major 11,
> causing `npm ci` / ERESOLVE failures on a fresh checkout. That condition is not
> present in the tree this document describes. `@nestjs/testing` is pinned to
> `11.2.6`, matching a runtime on 11.
>
> No dependency version was changed to "fix" it, because there was nothing to
> fix and a change would have been a fabricated fix. What was done instead is
> recorded below: the baseline is now **enforced by a guard script** and
> **documented**, so the same regression cannot be reintroduced silently. The
> historical state, which *was* real, is documented precisely so the reasoning
> is auditable.

Related: [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md),
[DEPLOYMENT.md](DEPLOYMENT.md), [runbooks/ROLLBACK_AND_RECOVERY.md](runbooks/ROLLBACK_AND_RECOVERY.md).

---

## 1. Scope and authority boundary

> [!IMPORTANT]
> The backend is a high-performance indexer and interface. Smart contracts and
> finalized canonical events remain strictly authoritative. Nothing in this
> document changes that, and no dependency choice here may be used to justify
> the API becoming authoritative for settlement, rewards, treasury, governance,
> claims, or disputes.

This document covers the **NestJS framework dependency baseline only**: which
majors are in use, why, which packages are allowed to differ, and how the
baseline is kept honest. It is a record and a guard description, not an upgrade
plan — the upgrade deferrals are in [§6](#6-upgrade-deferrals-record).

---

## 2. The reported condition, and what actually happened

The reported condition was real at one point on `main`. It is recorded here
because the way it arose is the reason the guard exists.

| Commit | `@nestjs/*` runtime | `@nestjs/testing` | State |
| ------ | ------------------- | ----------------- | ----- |
| `78fb2ee` / `9b157bc` (Dependabot dev- and prod-dependency bumps) | 12.x | `^12.0.2` | Consistent — both on 12. |
| `500bcc2` `fix(deps): restore compatible production dependency set` | downgraded 12 → 11 | **left at `^12.0.2`** | **Divergent. This is the reported bug.** |
| `2c4918c` `feat(outbox): transactional outbox, idempotent notification delivery, and read-path load budgets` | 11.x | pinned to exact `11.2.6` | Aligned — closed as a side effect of an unrelated feature commit. |
| Current tree | 11.x | `11.2.6` | Aligned. |

`500bcc2` moved `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`,
`@nestjs/swagger`, `@nestjs/jwt`, `@nestjs/passport`, `@nestjs/typeorm`,
`@nestjs/config`, `@nestjs/schedule`, `@nestjs/axios`, `@nestjs/bullmq` down to
their 11-line versions, but its diff to `devDependencies` did not touch
`@nestjs/testing`. That left the runtime on 11 and the test harness on 12.

Why that is a build failure rather than a style problem: the two majors declare
**mutually unsatisfiable peer ranges**, which is precisely the ERESOLVE
condition.

- `package-lock.json` records for `node_modules/@nestjs/testing@11.2.6`:
  `peerDependencies: { "@nestjs/common": "^11.0.0", "@nestjs/core": "^11.0.0",
  "@nestjs/microservices": "^11.0.0", "@nestjs/platform-express": "^11.0.0" }`
  (with `@nestjs/microservices` and `@nestjs/platform-express` optional).
- The published metadata for `@nestjs/testing@12.0.2` on the npm registry
  declares `peerDependencies: { "@nestjs/core": "^12.0.0",
  "@nestjs/common": "^12.0.0", "@nestjs/microservices": "^12.0.0",
  "@nestjs/platform-express": "^12.0.0" }`.

A runtime on 11 therefore cannot satisfy a testing package on 12, and `npm ci`
resolves strictly (it does not tolerate peer conflicts without
`--legacy-peer-deps`). **The lesson is not "pin the right number once"** — it is
that two Dependabot bumps (`78fb2ee`, `9b157bc`) had already moved the testing
package to 12, so any future automated bump group that touches only one side
can reopen this. A one-time fix does not survive Dependabot; a guard does.

---

## 3. The baseline

Resolved versions read directly from `package-lock.json` in the tree this
document describes. The `declared` column is from `package.json`.

### 3.1 Framework core — enforced to share one major

These ship as a release train; their majors move together.

| Package | declared | resolved | role |
| ------- | -------- | -------- | ---- |
| `@nestjs/common` | `^11.1.12` | `11.1.28` | runtime |
| `@nestjs/core` | `^11.1.12` | `11.1.28` | runtime |
| `@nestjs/platform-express` | `^11.1.12` | `11.1.28` | runtime |
| `@nestjs/testing` | `11.2.6` (exact) | `11.2.6` | testing — **enforced to match the runtime major** |

### 3.2 Dev tooling — reported, permitted to differ

| Package | declared | resolved | why it may differ |
| ------- | -------- | -------- | ----------------- |
| `@nestjs/cli` | `^12.0.1` | `12.0.1` | Build tool. Its recorded `peerDependencies` in `package-lock.json` are exclusively on build-tool packages — `@rspack/core`, `@swc/cli`, `@swc/core`, `fork-ts-checker-webpack-plugin`, `ts-loader`, `tsconfig-paths-webpack-plugin`, `webpack`, `webpack-node-externals` — and every one is marked `optional`. It declares **no** peer on `@nestjs/common` or `@nestjs/core`. |
| `@nestjs/schematics` | `^12.0.2` | `12.0.2` | Same argument; it is a dependency of `@nestjs/cli`, not of the running application. Its own peers are `prettier ^3.0.0` (optional) and `typescript >=6.0.0`. |

Consequence: **downgrading `@nestjs/cli` / `@nestjs/schematics` to 11 would be an
unmotivated downgrade.** There is no major mismatch to correct here, the tooling
is decoupled from the runtime by design, and forcing the numbers to match would
buy nothing while creating an unmotivated diff. The guard therefore reports
tooling majors and does not enforce them.

### 3.3 Satellite integrations — own release cadence, reported

These track their own majors, and their peer ranges legitimately span several
NestJS majors. Forcing them to equal the framework major would be wrong.

| Package | declared | resolved | note |
| ------- | -------- | -------- | ---- |
| `@nestjs/axios` | `^4.0.1` | `4.0.1` | own line |
| `@nestjs/bullmq` | `^11.0.4` | `11.0.4` | own line; `bullmq` itself is `^5.77.6` |
| `@nestjs/config` | `^4.0.2` | `4.0.4` | own line |
| `@nestjs/jwt` | `^11.0.2` | `11.0.2` | own line |
| `@nestjs/mapped-types` | `*` | `2.1.1` | **unpinned — see [§5.1](#51-unpinned-wildcard-range-on-one-entry)** |
| `@nestjs/passport` | `^11.0.5` | `11.0.5` | own line |
| `@nestjs/schedule` | `^6.1.1` | `6.1.1` | own line |
| `@nestjs/swagger` | `^11.2.5` | `11.4.6` | own line |
| `@nestjs/throttler` | `^6.5.0` | `6.5.0` | own line; its recorded peers explicitly accept `@nestjs/common`/`@nestjs/core` `^7 \|\| ^8 \|\| ^9 \|\| ^10 \|\| ^11` |
| `@nestjs/typeorm` | `^11.0.0` | `11.0.0` | own line; peers accept `^10.0.0 \|\| ^11.0.0` |

### 3.4 Toolchain

| Item | Value | Source |
| ---- | ----- | ------ |
| Node | `>=20 <21` | `package.json` → `engines.node` |
| npm | shipped with the Node 20 line | CI uses `actions/setup-node` with `node-version: '20'` |
| Lockfile | `package-lock.json` | `package.json`; the tree is not using npm workspaces or a second lockfile at the root |
| Install | `npm ci` | CI's "Install dependencies" step; no `--force`, no `--legacy-peer-deps` anywhere in `.github/workflows/ci.yml` |

There is no `.npmrc`, `.nvmrc`, or `.node-version` in the repository, so
`engine-strict` is **not** enabled in-repo. That matters for [§5.2](#52-schematics-engine-range-vs-the-repository-node-range).

---

## 4. The guard

### 4.1 Command

Run from the repository root. It is a plain Node ESM script with no
dependencies, so it works on a bare checkout with no install step:

```bash
node scripts/check-nest-baseline.mjs
```

Variants:

```bash
node scripts/check-nest-baseline.mjs --strict    # also fail on unpinned satellite ranges
node scripts/check-nest-baseline.mjs --json      # machine-readable summary on stdout
node scripts/check-nest-baseline.mjs --help
```

**There is deliberately no `package.json` script entry for this.** `package.json`
is owned by a separate, concurrent change in this repository, and
`.github/workflows/ci.yml` is likewise owned by a concurrent change; neither is
edited here. Documenting the raw `node` command is the supported invocation.
Wiring the guard into CI is a one-line follow-up for whoever owns those files:

```yaml
- run: node scripts/check-nest-baseline.mjs
```

### 4.2 What it enforces (exit 1 on any violation)

1. **Required packages present** — `@nestjs/common`, `@nestjs/core`,
   `@nestjs/platform-express`, `@nestjs/testing` are all declared. Removing
   `@nestjs/testing` to make a conflict disappear is a regression, not a fix.
2. **Framework core agrees on one major** — every
   `@nestjs/{common,core,platform-express,platform-fastify,microservices,websockets}`
   entry pins a concrete major, and all of them are the same major.
3. **Testing matches runtime** — `@nestjs/testing` pins a concrete major, and it
   equals the framework-core major. This is the exact condition from §2.
4. **Lockfile peers admit the resolved tree** — when `package-lock.json` is
   present, every installed `@nestjs/*` peer of the resolved
   `@nestjs/testing` falls inside the peer range the lockfile records for it.
   Optional peers that are not installed are skipped, not assumed satisfied.
5. **Tooling is dev-only** — `@nestjs/testing`, `@nestjs/cli` and
   `@nestjs/schematics` are under `devDependencies`, so production images do not
   carry test or build tooling.
6. **Pinned majors** — a framework-coupled package whose range does not pin a
   major is a failure. Under `--strict`, this extends to every `@nestjs/*` entry.

### 4.3 What it deliberately does not enforce

- **Tooling majors.** See §3.2. Reported only. A major ahead of runtime is a
  supported configuration, not a defect.
- **Satellite majors, by default.** See §3.3. Reported, and flagged with a note
  when a satellite's declared major runs ahead of the framework major, because
  that is the case where a peer range deserves a human look.
- **Anything about the install, build, typecheck, or tests.** The script reads
  `package.json` and `package-lock.json` and nothing else. It never reads
  `node_modules`, never makes a network call, and never writes. A green run is
  evidence about *declared and resolved versions only* — it is not evidence that
  `npm ci`, `tsc`, `jest`, or `nest build` succeed.

### 4.4 Exit codes

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `0` | Baseline consistent. Non-blocking notices may still be printed; a notice is not a verification. | Nothing. Read the notices — they are the drift signals. |
| `1` | Baseline violated. At least one `[FAIL]` line was printed with a remedy. | Fix the named package(s), re-run, then run the full verification in [§4.5](#45-verification-the-issue-asked-for). |
| `2` | Usage error, or `package.json` unreadable/unparseable. | Fix the invocation (`--help`) or the repository file. |

### 4.5 Verification the issue asked for

The acceptance criteria for #515 ask for before/after evidence. Recorded
honestly:

| Evidence item | Value | Who confirms it |
| ------------- | ----- | --------------- |
| Declared ranges, before and after | **Unchanged.** No `@nestjs/*` range in `package.json` was modified by this work; see `git show --stat` for this change — `package.json` and `package-lock.json` are not in it. | Author (by diff) |
| Resolved versions, before and after | **Unchanged**, and listed in §3.1–§3.3 as read from `package-lock.json`. | Author (by reading the lockfile) |
| Guard demonstrates alignment | `node scripts/check-nest-baseline.mjs` prints `BASELINE CONSISTENT (framework major 11)` and exits `0`. The same script run against a copy of `package.json` with `@nestjs/testing` set back to `^12.0.2` prints `BASELINE VIOLATED` for `testing-alignment` and exits `1`, which is the regression from §2. | Author (by running the script) |
| **Fresh checkout + `npm ci` completes with no `--force` / `--legacy-peer-deps`** | **NOT VERIFIED.** Requires `npm ci` to be run. | Maintainer |
| **Typecheck passes** | **NOT VERIFIED.** | Maintainer |
| **Unit/integration tests pass** (`npm run test:cov`) | **NOT VERIFIED.** | Maintainer |
| **Production build passes** (`npm run build`) | **NOT VERIFIED.** | Maintainer |
| **No unrelated framework migration** | Satisfied by construction: this change adds one script and four documents and touches no application source, no `package.json`, no lockfile. | Reviewer |

The `npm ci` row is the one that actually closes the issue, and it is the
maintainer's to run. Everything above it is evidence about versions, not about
the build.

---

## 5. Residual risk, recorded honestly

These are real observations from reading `package.json`, `package-lock.json` and
`.github/workflows/ci.yml`. None of them has been reproduced by running an
install. They are listed because leaving them undocumented is how the next
`ERESOLVE` happens.

### 5.1 Unpinned wildcard range on one entry

`@nestjs/mapped-types` is declared as `"*"`. It resolves to `2.1.1` in the
lockfile today, but a lockfile regeneration can move it to any 2.x/3.x/… release
without any change appearing in `package.json` diff review. The guard reports
this as a non-blocking notice by default and fails on it under `--strict`.

This is a decision for a maintainer, deliberately not made unilaterally here:
either pin a concrete range, or accept the wildcard in writing and keep running
the guard in default (non-strict) mode. Pinning is the safer of the two and
would make `--strict` viable as a CI gate.

### 5.2 Schematics engine range vs the repository Node range

`@nestjs/schematics@12.0.2` records
`engines: { "node": "^22.22.3 || ^24.15.0 || >=26.0.0" }` in
`package-lock.json`. The repository declares `engines.node: ">=20 <21"` and CI
runs `node-version: '20'`. These do not overlap.

Because the repository has no `.npmrc`, npm's `engine-strict` is not enabled, so
this is expected to surface as a warning during install rather than a hard
failure. **That expectation has not been confirmed here.** A maintainer running
`npm ci` should watch for `EBADENGINE` warnings and report them; if
`engine-strict` is ever enabled anywhere in the pipeline (a `.npmrc`, an
`engine-strict=true` in npm config, or a future runner policy), this becomes a
hard install failure for a dev-only package.

Related: `@nestjs/schematics@12.0.2` declares peer `typescript >=6.0.0`, while
the lockfile resolves `typescript` to `5.9.3` (declared `^5.7.2`). The CLI
carries its own nested `typescript ~6.0.2`. Again a tooling-only peer, and again
not reproduced here.

### 5.3 The guard is not wired into CI

Deliberate, to avoid colliding with the concurrent change that owns
`.github/workflows/ci.yml`. Until it is wired in, alignment is a convention
documented here rather than an enforced gate. The one-line addition is in
[§4.1](#41-command).

### 5.4 Baseline is a floor, not a ceiling

The guard prevents the majors from *diverging*. It does not prevent an
automated bump group from moving the whole framework to a new major in one
commit, which is a legitimate but review-worthy change. Reviewing `package.json`
diffs for `@nestjs/*` lines remains necessary; the guard is a backstop, not a
substitute for review.

---

## 6. Upgrade deferrals record

**NestJS 12 is deliberately deferred.** This is a decision, not an oversight.

### 6.1 Why it was reverted in the first place

`500bcc2` and `40700bc` (`fix(deps): restore compatible production lockfile`,
merged via PR #514, `fix/revert-unsafe-production-upgrades`) moved the runtime
off 12 and back to 11. The commit subject records the reason: the production
dependency set was not compatible. That work landed after the 12.x bump, and
this change does not revisit or relitigate it.

### 6.2 What a move to a new major would require

Recorded so the next attempt starts from facts rather than from `npm install
@nestjs/core@latest`:

1. **Move the whole framework train together.** `@nestjs/common`, `@nestjs/core`,
   `@nestjs/platform-express`, and `@nestjs/testing` in one commit. Moving the
   runtime and not the testing package is precisely the failure in §2.
2. **Re-audit every satellite against the new major's peer ranges**, not just the
   core. `@nestjs/config`, `@nestjs/schedule`, `@nestjs/axios`, `@nestjs/
   bullmq`, `@nestjs/throttler`, `@nestjs/swagger`, `@nestjs/typeorm`,
   `@nestjs/jwt`, `@nestjs/passport` each publish their own supported range; the
   11-line versions recorded in §3.3 were selected against NestJS 11.
3. **Re-derive `engines.node`.** The Node range would need to move to satisfy
   the CLI/schematics engine requirements in [§5.2](#52-schematics-engine-range-vs-the-repository-node-range),
   or the tooling would need to be held back deliberately. CI pins
   `node-version: '20'` and would have to move with it.
4. **Regenerate the lockfile and read the diff in full.** A major move rewrites
   hundreds of lockfile lines; the peer-resolution result is the deliverable,
   not the line count.
5. **Run the verification in §4.5 and record the results in that table.** A
   dependency move without a recorded `npm ci` / typecheck / test / build result
   is an unverified change.

### 6.3 What must be checked before starting

- Confirm the current tree is green first. A major move on top of a red baseline
  makes attribution impossible.
- Confirm the target major's breaking changes against this codebase's surface
  area: global guards and interceptors registered via `APP_GUARD` /
  `APP_INTERCEPTOR` in `src/app.module.ts`, the `ValidationPipe` configuration in
  `src/bootstrap.ts`, `BullModule`/`@nestjs/bullmq` integration, and
  `SwaggerModule` document generation. These are the places a framework major
  typically bites.
- Confirm the `@nestjs/throttler` storage interface used by the custom
  `ThrottlerRedisStorage` / `ThrottlerMemoryStorage` classes in
  `src/app.module.ts` still matches the installed version's contract. These are
  hand-written implementations of a third-party interface, which is the kind of
  code a major bump breaks silently.
- Re-read `package-lock.json` peer ranges for `@nestjs/throttler` and
  `@nestjs/typeorm` specifically; both are recorded as multi-major ranges and
  could silently stop covering the new runtime.

---

## 7. Change record

| Date | Author | Change |
| ---- | ------ | ------ |
| 2026-09-25 | `DevMuhdishaq (@DevMuhdishaq)` | Created this document and `scripts/check-nest-baseline.mjs` for #515 (STAB-BE-001). No dependency version was changed. The reported major mismatch was not reproducible on current `main`; the historical divergent state (`500bcc2`) is documented in §2. |

**Revision note.** This is a first revision. It describes a baseline that was
read from `package-lock.json`, not one that was installed and exercised. The
verification table in [§4.5](#45-verification-the-issue-asked-for) is
deliberately explicit about which rows are unverified; a later revision should
fill those rows in with real results and cite the commit or CI run that produced
them, not with a claim.
