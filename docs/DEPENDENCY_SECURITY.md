# Dependency Security

Working document for STAB-BE-004 (issue #518, "Remediate API Dependency Vulnerabilities in
Reviewable Batches").

> [!IMPORTANT]
> **This is a scaffold with a defined procedure, not a completed audit.** No vulnerability
> scanner was run to produce it. Every finding row below is empty on purpose. Populate it
> from the `npm audit` artifact that CI now publishes, then work the batches below.

## Why this document exists

The acceptance criteria for #518 require that no critical vulnerability remains without an
explicit maintainer-approved risk record, that high findings are fixed or documented with
package path, exploitability, owner and follow-up, and that `npm audit` runs in CI and
publishes evidence. Two of those three are process, not code: the table and the record
format have to exist and be used consistently. This document is that process.

## Method, and its limits

**What was actually done to build this document.** The declared version ranges in
`package.json` and the resolved versions in `package-lock.json` were read directly. That is
the whole evidence base. Nothing was installed, no scanner was run, and no advisory database
was queried.

**What that means for the table below.** The table cannot contain severities, advisory
identifiers, CVSS scores or fix versions, because producing any of those would require
querying an advisory database. Writing them from memory would be fabrication, so they are
left blank. The columns that *can* be filled honestly from the repository - package path,
runtime reachability, owner, follow-up - are the ones the acceptance criteria ask for, and
the rows are seeded from the dependency inventory below as a starting structure.

**What is required to complete it.** Run the scanner and paste the result in. The
`Security Scans` job in `.github/workflows/ci.yml` runs:

```bash
npm audit --audit-level=high
```

with `set -o pipefail`, so a high or critical finding still fails the workflow. The same
output is written to `npm-audit-report.txt` and uploaded as the `npm-audit-report` workflow
artifact with a 90-day retention, so the evidence for a given commit is retrievable without
re-running anything. Download that artifact for the commit under review, and transcribe each
advisory into the table.

## What is already in place

These were present before this change and were deliberately kept:

| Control | Where | Notes |
| --- | --- | --- |
| `npm audit --audit-level=high` | `ci.yml`, `Security Scans` job | The canonical dependency scanner. Already failing the build on a high finding. |
| TruffleHog secret scanning | `ci.yml`, `Security Scans` job | `trufflesecurity/trufflehog`, pinned to a commit SHA. |
| CodeQL for JavaScript/TypeScript | `ci.yml`, `Security Scans` job | The only job with `security-events: write`. |
| Trivy OS and library scan of the built image | `ci.yml`, `Container Vulnerability Scan` job | `exit-code: '1'`, `severity: 'CRITICAL,HIGH'`, `ignore-unfixed: true`. |
| Weekly npm Dependabot updates | `.github/dependabot.yml` | Grouped into production and development dependency PRs, max 5 open. |
| `npm ci` everywhere | `ci.yml`, `Dockerfile` builder stage | Installs the exact lockfile tree; drift fails the build. |

Added by this change: the `npm audit` output is now retained as an artifact, and
`security-scans` runs `npm ci` so the audit is evaluated against the tree that actually ships
rather than against a lockfile with nothing installed next to it.

## Declared versus resolved versions

Read from `package.json` and `package-lock.json`. The `lockfileVersion` is 3 and the supported
npm major is 10 (see the toolchain section of `DEPLOYMENT.md`).

| Package | Declared range | Resolved | Note |
| --- | --- | --- | --- |
| `@anthropic-ai/sdk` | `^0.115.0` | see lockfile | |
| `@bull-board/api`, `@bull-board/express`, `@bull-board/nestjs` | `^7.1.5` | see lockfile | |
| `@libsql/client` | `^0.17.0` | `0.17.0` | Pinned to an exact resolved version in the lockfile. |
| `@nestjs/*` (common, config, core, jwt, mapped-types, passport, platform-express, schedule, swagger, throttler, typeorm) | `^4.x` - `^11.x` | see lockfile | `@nestjs/mapped-types` is declared as `*`, which is unpinned in `package.json`; the lockfile is the only thing constraining it. |
| `@prisma/adapter-libsql`, `@prisma/client` | `^7.3.0` | `7.4.1` | Retained with reasons in `PRISMA_INVENTORY.md`. |
| `axios` | `^1.18.1` | see lockfile | |
| `bullmq` | `^5.77.6` | see lockfile | |
| `ethers` | `^6.16.0` | see lockfile | |
| `ioredis` | `^5.9.3` | see lockfile | |
| `jsonwebtoken` | `^9.0.3` | see lockfile | |
| `openai` | `^7.1.0` | see lockfile | |
| `passport`, `passport-jwt` | `^0.7.0`, `^4.0.1` | see lockfile | |
| `pg` | `^8.17.2` | see lockfile | Production database driver. |
| `pino`, `pino-http`, `pino-pretty` | `^9.4.0`, `^10.3.0`, `^11.2.0` | see lockfile | |
| `prom-client` | `^15.1.3` | see lockfile | |
| `socket.io` | `4.8.1` (exact) | see lockfile | One of the few exactly-pinned runtime dependencies. |
| `sqlite3` | `^5.1.7` | see lockfile | |
| `typeorm` | `^0.3.28` | see lockfile | Persistence layer. |
| `web3` | `^4.16.0` | see lockfile | Large transitive surface. |

Development-only: `@nestjs/cli`, `@nestjs/schematics`, `@nestjs/testing`, `prisma`, `jest`,
`ts-jest`, `@swc/jest`, `ts-node`, `ts-loader`, `typescript`, `eslint`, `prettier`,
`supertest`, `tsconfig-paths`, and the `@types/*` set. `npm prune --production` removes all of
these from the shipped image, and the container smoke workflow asserts that
`typescript`, `@nestjs/cli`, `jest` and `prisma` are absent from it.

Note: the "see lockfile" entries are deliberate. Transcribing the full transitive resolution
graph here would be a large, immediately stale document; the lockfile is the record, and the
`npm audit` artifact is the evidence.

## Finding table

Populate one row per advisory from the `npm audit` artifact. **Do not leave a row blank and
do not guess a severity** - if the scanner did not report it, it is not a finding; if it did,
copy the severity verbatim.

| # | Package path | Advisory | Severity | Exploitability / runtime reachability | Owner | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | _(unpopulated)_ | | | | | | |
| 2 | _(unpopulated)_ | | | | | | |

Column notes:

- **Package path** - the `node_modules/...` path from the scanner output, so the row is
  unambiguous when a package appears more than once in the tree.
- **Severity** - verbatim from the scanner (`critical`, `high`, `moderate`, `low`). Do not
  upgrade or downgrade a severity to make a batch easier to close.
- **Exploitability / runtime reachability** - the judgement a scanner cannot make. Classify
  each finding as one of:
  - `reachable` - the vulnerable code path can be invoked through an HTTP route, a queue
    consumer, or an indexer event handler.
  - `dev-only` - only present in `devDependencies`, and confirmed absent from the shipped
    image by the container smoke workflow. Cannot be reached in production, but still worth
    fixing because it can compromise a build.
  - `transitive-unreachable` - reachable only through a dependency path the application does
    not use. Record *why* it is unreachable, not just that it is.
  - `build-time` - only affects the build.
- **Owner** - the CODEOWNERS entry for the affected path, or the CODEOWNERS entry for
  `.github/workflows/` if the finding is a CI action pin. See `.github/CODEOWNERS`.
- **Follow-up** - the batch id from "Batching rule" below, or a link to a risk-acceptance
  record.
- **Status** - `open`, `fixed`, `risk-accepted`, or `not-reachable` (with the justification
  in the exploitability column).

## Batching rule

Remediation lands in **reviewable batches**, defined as follows.

1. **One logical remediation per batch.** A batch fixes one advisory, one advisory class
   across a coherent dependency set (for example "all `tar` advisories in the lockfile"), or
   one upstream major-version migration.
2. **No unrelated major migrations bundled.** A major-version bump of an unrelated package
   never rides along with a patch. If two majors are both needed, they are two batches, and
   the second is stacked on the first rather than merged with it.
3. **One lockfile per batch.** Each batch changes `package.json` and `package-lock.json` and
   nothing else, so the diff is reviewable as a dependency change.
4. **Batches are ordered by runtime reachability**, not by severity alone. A `reachable`
   `moderate` outranks an unreachable `critical`, because reachability is the part that
   actually decides whether the package is exploitable.
5. **Each batch states its verification.** A batch is not done until the maintainer has run
   the build and the test suite locally, or the batch explicitly carries that as outstanding.
   Nothing in this repository should be merged with an unverified lockfile change; an
   unverifiable lockfile edit is the failure mode this issue exists to prevent.

Suggested initial batch order, to be confirmed against the audit output:

| Batch | Scope |
| --- | --- |
| B1 | Every `reachable` finding, one advisory per batch |
| B2 | Every `dev-only` finding, one advisory per batch |
| B3 | Runtime dependency major upgrades, one package per batch |
| B4 | Development dependency major upgrades, one package per batch |
| B5 | Residual `transitive-unreachable` and `build-time` findings, closed by reachability rationale or a risk-acceptance record |

## Risk-acceptance record format

A **critical** finding may only be closed without a fix by a maintainer filing this record.
No other closure is acceptable, and the record must be in the pull request that closes the
finding, not only in this file.

```
## Risk acceptance: <advisory id> in <package path>

- **Finding:**        <advisory id, severity, one-line description>
- **Version:**        <declared range> -> <resolved version in package-lock.json>
- **Reachability:**   <reachable | dev-only | transitive-unreachable | build-time>
                      <the concrete reason, naming the code path>
- **Impact if hit:**  <what an attacker gains, in terms of this system>
- **Compensating controls:** <e.g. Trivy ignores-unfixed for a base-image-only finding;
                      CodeQL coverage; the fact that the package is absent from the shipped
                      image>
- **Why not fixed now:** <the reason, concretely>
- **Owner:**          <maintainer, @handle>
- **Approved by:**    <maintainer, @handle>
- **Approved on:**    <YYYY-MM-DD>
- **Expires / re-review on:** <YYYY-MM-DD>
- **Issue to track the fix:** <link, or "none - accepted indefinitely">
```

Rules for the record:

- **Every critical finding needs one**, even if the reachability assessment is "not
  reachable". The assessment is the value; the approval is the accountability.
- **An expiry date is mandatory.** A record without a re-review date is a permanent silent
  waiver, which is what the acceptance criteria are designed to prevent. Choose a date at most
  90 days out.
- **The approver is a maintainer**, not the author of the batch that surfaced the finding.
- **Critical findings with `reachable` classification are not waivable.** Fix them. The
  record is for critical findings that are genuinely not exploitable in this deployment.

## Residual risk in this change

`package.json` dependency ranges and `package-lock.json` are **unmodified** by this change.
No advisory data was gathered, so no remediation could be justified, and a lockfile edit
that cannot be regenerated and verified locally is precisely the unverifiable change this
issue warns about. `package.json` received one non-dependency edit: `engines.npm` was added
to pin the supported npm major alongside the existing `engines.node`. That field is metadata,
is not resolved as a package, and does not affect the dependency graph.
