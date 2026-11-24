# Static Analysis: CodeQL Coverage, Schedule, and Suppression Policy

> **Scope.** What CodeQL analyses in this repository today, what the scheduled
> run adds on top of CI, how to read an alert, and the rules for suppressing
> one. Related: [`CONTAINER_IMAGE.md`](./CONTAINER_IMAGE.md) (image hardening),
> [`DEPENDENCY_SECURITY.md`](./DEPENDENCY_SECURITY.md) (dependency-layer
> scanning, owned by a parallel change).

---

## 1. What is enforced today

| Layer | Where | When | What it does |
| ----- | ----- | ---- | ------------ |
| CodeQL (PR + push) | `.github/workflows/ci.yml` → `security-scans` | `push` to `main`, `pull_request` to `main` | `github/codeql-action/init@v4` + `analyze@v4`, `languages: javascript, typescript` |
| CodeQL (schedule) | `.github/workflows/codeql-schedule.yml` | `schedule` (weekly, Mon 03:17 UTC) + `workflow_dispatch` | Same two actions, same config file, same SARIF destination |
| Dependency audit | `ci.yml` → `security-scans` | same | `npm audit --audit-level=high` |
| Secret scanning | `ci.yml` → `security-scans` | same | TruffleHog against the PR diff |
| Container scan | `ci.yml` → `container-scan` | same | Trivy, `CRITICAL,HIGH`, `os,library`, `ignore-unfixed` |
| Lint / types | `ci.yml` → `build-and-test` | same | `eslint` (non-mutating), `nest build`, `jest --coverage`, Prisma migration reset/deploy |

**CodeQL is genuinely enforced already.** This change does not introduce it,
and it would be dishonest to claim otherwise. What it introduces is the
scheduled lane and the shared configuration file.

### 1.1 The configuration file

`.github/codeql/config.yml` is the single place that defines *what* is
analysed, for **both** workflows:

```yaml
disable-default-queries: false     # baseline suite is kept
queries:
  - uses: security-extended
  - uses: security-and-quality
paths:
  - src                            # the entire shipped application
paths-ignore:
  - dist, build, coverage, node_modules
  - src/generated                  # machine-generated Prisma client
  - "**/*.js.map"
```

The `security-extended` and `security-and-quality` suites are **additive** to
the default suite. `disable-default-queries: false` is spelled out explicitly
so that a future edit cannot quietly drop the baseline.

`paths-ignore` is limited to build output and generated artifacts. It
deliberately does **not** exclude `**/*.spec.ts` or any source directory. A
`paths-ignore` entry is a blind spot that a future contributor cannot see the
consequence of, and widening it to make an alert count look better is a
coverage regression disguised as hygiene.

---

## 2. What the schedule adds (the actual gap being closed)

`ci.yml` triggers on `push`/`pull_request` **into `main`**. Between two such
events, CodeQL analyses nothing. During that window, GitHub can ship:

- a **new query** (a newly authored `js/...` security or quality check),
- an **updated query** (a refined dataflow that newly matches existing code),
- a **new taint-mode model** for a library this repo uses,
- a **new CWE mapping** that reclassifies an already-reported alert.

None of these are visible in a code review, and none of them re-trigger
`ci.yml`. On a repository whose purpose is to index a financial protocol, an
undetected injection or SSRF introduced on `main` by an unrelated commit is
precisely the class of failure that code review does not catch.

`codeql-schedule.yml` therefore re-analyses the default branch weekly, plus on
demand:

- `schedule: '17 3 * * 1'` — Monday 03:17 UTC. Off-the-hour on purpose;
  GitHub's shared scheduler is oversubscribed at `:00` and on-hour jobs are
  routinely delayed or dropped.
- `workflow_dispatch` with an optional `target_ref`, so a specific branch, tag,
  or SHA can be scanned during an incident.

Both lanes upload to the **same SARIF stream** (the repository's Code scanning
alerts). Scheduled results therefore *add* findings to the security tab rather
than creating a parallel set that nobody reads.

### 2.1 Operational properties of the scheduled lane

| Property | Value | Reason |
| -------- | ----- | ------ |
| `permissions` | `contents: read`, `security-events: write` | The minimum CodeQL needs. No write access to the repo, packages, deployments, or issues. Restated at job level as well. |
| Action pinning | Full 40-char commit SHAs | See §6. |
| `build-mode` | `none` | JavaScript/TypeScript is analysed from source; there is no compiler step to trace. Avoids a redundant `npm ci` + `npm run build`, and prevents an unrelated build failure from faking or masking a scan result. |
| `clean` | `true` | A stale partial cache must never be able to suppress an alert. |
| `upload-sarif` | `true` (explicit on `analyze`) | A green run with no SARIF is indistinguishable from a silently broken scanner. |
| `wait-for-processing` | `true` | Block until results land in the security view; otherwise a "successful" scan whose alerts never appeared is worse than a visible failure. |
| `fail-on-errors` | default (`true`) | Analysis *errors* — bad config, extractor crash, upload failure — must fail loudly. |
| `concurrency.cancel-in-progress` | `false` | Two overlapping runs uploading SARIF for the same ref race; the loser's alerts can vanish. Queue instead. |
| `timeout-minutes` | `60` | A hung analysis is a failure, not a job that runs until the 6-hour cap. |
| Injection safety | Dispatch input passed via `env`, not interpolated into the shell | A hostile `target_ref` cannot become shell script. |

The scheduled lane does **not** fail the build on new alerts. Alert triage is
a review process, and a scheduled gate that goes red on the first new
quality-query hit trains people to re-run instead of to triage. Enforcement of
*analysis errors* is a different thing and is kept strict.

---

## 3. Reading an alert

**Security → Code scanning → an alert.** Useful fields:

| Field | How to use it |
| ----- | ------------- |
| Rule ID | The query identity. `js/...` is a security query; `js/quality/...` or `js/maintainability/...` is from `security-and-quality` and is advisory, not a vulnerability. |
| Severity | `critical`/`high` → triage within the current sprint. `medium`/`low` and quality alerts → normal backlog. Severity is CodeQL's confidence-weighted estimate, not a CVSS score and not a statement of exploitability here. |
| Tags | The CWE mapping and the suite the query came from. |
| "Introduced by" | The commit/PR that created the path. If it says a merge commit from a long-ago PR, it is pre-existing, not a regression. |
| Location | File plus the exact tainted source/sink pair CodeQL traced. |
| "Show more" | The full dataflow. Read it end to end before triaging — CodeQL traces are precise about *where* and frequently imprecise about *whether*. |

### 3.1 Triage order

1. **Reproduce the flow.** Follow the reported source → intermediate → sink.
   Ask: does untrusted input actually reach the sink in a reachable path?
2. **Classify the exposure.** For an indexer, the realistic untrusted inputs
   are HTTP request bodies/params (including spoofable headers) and on-chain
   event `payload` JSON. Anything sourced from `process.env` or from a
   hard-coded, approved contract address is not attacker-controlled.
3. **Decide.** Fix, document-and-accept, or suppress — never "ignore".
4. **For a real finding**, fix it in the same PR that triaged it. Do not let
   a triaged `critical` sit in the backlog.

### 3.2 Findings that will legitimately recur

Expect recurring alerts in these areas, and triage them as a class rather than
one at a time:

- `js/sql-injection` on `createQueryBuilder` string fragments. TypeORM
  parameterises `:named` binds; raw `.where(\`... ${x}\`)` fragments are real
  findings and should be fixed.
- Path/URL handling in the IPFS, notification, and blockchain RPC clients.
- `js/insecure-randomness` for anything that is *not* a security token
  (correlation ids, cursor nonces). A finding on a JWT secret or a
  wallet-challenge nonce *is* real.
- `security-and-quality` maintainability queries (unused variables, empty
  blocks). Advisory. Note the repository already has known dead code in this
  category — see §5.

---

## 4. Suppression policy

> **A suppression is a documented, time-boxed assertion that a finding is not
> a vulnerability. It is not a way to make a number go down.**

Rules:

1. **No blanket suppressions.** Never suppress a whole rule, a whole file, or
   a whole directory. Never add an `exclude:` to `.github/codeql/config.yml`
   to silence a query. The config file's coverage is reviewable; a query
   exclusion there is permanent and invisible to whoever reads an alert.
2. **Suppress at the alert, in the security tab.** Use the dismiss reason
   `Used in tests`, `False positive`, or `Won't fix`. The reason and author are
   recorded in the alert's audit trail, where they are reviewable.
3. **Every suppression carries an expiry.** Record the expiry date in the
   dismissal comment. A suppression without an expiry date is rejected at
   review.
4. **Justification must name the reason, not the conclusion.** "`js/x` is a
   false positive here" is not a justification. "`process.env.DATABASE_URL` is
   set from the orchestrator's secret store at pod start and is never
   derived from request data; there is no path from a request parameter to
   this sink" is.
5. **`Wont't fix` is for ≤ 1 sprint.** Anything longer is `False positive` with
   an honest note, or it gets fixed.
6. **A high/critical alert may not be suppressed without a second reviewer's
   sign-off recorded in the dismissal comment.**
7. **Re-open on material change.** If the code at the alert's location
   changes, the alert reopens automatically. Do not suppress the replacement
   on the basis of the old suppression.
8. **Suppressions are reviewed on a cadence.** Whoever owns
   `.github/codeql/config.yml` re-reviews open suppressions monthly. Anything
   past its expiry is either fixed or re-justified in writing.

---

## 5. Known gaps

Stated plainly, because a security document that claims completeness is worse
than no document.

1. **`ci.yml` is not yet pinned or least-privileged.** Its `security-scans`
   job already declares `contents: read` + `security-events: write` (correct),
   but its actions are referenced by floating major tags
   (`github/codeql-action/init@v4`, `trufflesecurity/trufflehog@main`,
   `aquasecurity/trivy-action@master`, `actions/checkout@v7`). `trufflehog@main`
   and `trivy-action@master` are mutable *branches*, not tags — they can be
   repointed at arbitrary content at any time by anyone with push access to
   those repositories. **A parallel PR owns `ci.yml` and is responsible for
   pinning all of them to full SHAs and setting an explicit
   `permissions:` block on every job.** This change deliberately does not
   touch `ci.yml`, so the two PRs merge without conflict.
2. **`trufflesecurity/trufflehog@main` and `aquasecurity/trivy-action@master`**
   are the highest-value pinning targets in the whole workflow, and are out
   of scope here for the same reason.
3. **No SARIF is archived as a build artifact.** If a run's alerts are
   dismissed wholesale, the run history in the security tab is the only
   record. Uploading the SARIF as a workflow artifact would give a durable,
   diffable history. Left for the `ci.yml` owner.
4. **CodeQL covers `javascript, typescript` only.** No compiled-language
   analysis, and no `actions` language analysis of the workflow files
   themselves — so workflow-level issues (e.g. a script-injection in a `run:`
   block, which is a real class of GitHub Actions vulnerability) are not
   covered by CodeQL here. Enabling `languages: actions` is a one-line change
   but is owned by the `ci.yml` PR.
5. **Nothing enforces the "backend never decides protocol outcomes" invariant
   statically.** The project's core rule — deployed Optimism/EVM contracts and
   finalized canonical events are the only authority — is enforced by review
   and by unit tests today, not by a query. A custom CodeQL query for it would
   be a genuinely valuable follow-up.
6. **There is no SAST beyond CodeQL in the pull-request path.** `eslint` with
   `eslint-plugin-security`/`eslint-plugin-no-unsanitized` is not configured.
   That is a real gap and is a separate change.
7. **The scheduled lane has not been observed running.** The workflow file is
   new; its first scheduled execution is up to seven days after merge. Until a
   run completes, treat the schedule as unproven.

---

## 6. Action pinning

Both actions in `codeql-schedule.yml` are pinned to full 40-character commit
SHAs, with the human-readable version in a trailing comment:

| Action | SHA | Version |
| ------ | --- | ------- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7.0.1` |
| `github/codeql-action` | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` | `v4.38.2` |

Both were resolved from the GitHub API (the `codeql-action` SHA corresponds to
a PGP-signed merge commit dated 2026-09-24). To re-derive, or to refresh to a
newer release:

```bash
gh api repos/github/codeql-action/commits/v4 --jq .sha
gh api repos/actions/checkout/commits/v7   --jq .sha
```

A fabricated or mistyped SHA fails the workflow at action-resolution time with
an opaque error, so an unresolvable SHA is always left as an explicit TODO
rather than guessed. **No TODO placeholders remain in this workflow** — both
were resolved for real.

When bumping, update the SHA *and* the `# vX.Y.Z` comment together; a bare SHA
with no version comment is unauditable in a diff.
