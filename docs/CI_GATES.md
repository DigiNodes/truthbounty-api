# CI Gates

Reference for the required CI gate set, for branch protection configuration. Written for
STAB-BE-005 (issue #519, "Restore the API Required CI Gate Set").

## Stable job names

Branch protection must key on these. The **job id** in the left column is the YAML key and
is what a branch-protection rule matches; the **display name** in the right column is what a
reviewer sees. Both are stable. Renaming either is a breaking change for branch protection
and must update this table in the same pull request.

| Job id (YAML key) | Display name | Workflow | Blocking? | What it proves |
| --- | --- | --- | --- | --- |
| `build-and-test` | Build, Lint, and Test | `ci.yml` | **Yes** | `npm ci` succeeds against the lockfile, `npm run build` produces no uncommitted artifact drift, ESLint is clean, and the Jest suite passes with coverage. |
| `node-toolchain` | Node/npm Toolchain | `ci.yml` | **Yes** | The runner's `node` and `npm` major versions match `engines`, the lockfile is `lockfileVersion: 3`, and `npm ci` did not modify `package.json` or `package-lock.json`. |
| `schema-migration-gate` | Schema Migration and Drift Gate | `ci.yml` | **Yes** | All TypeORM migrations in `src/migrations/` apply to an empty PostgreSQL database, the latest one is reversible and re-appliable, and the entities do not drift from the migrated schema. |
| `security-scans` | Security Scans | `ci.yml` | **Yes** | `npm audit --audit-level=high`, TruffleHog secret scanning, and CodeQL for JavaScript/TypeScript. Uploads the audit output as the `npm-audit-report` artifact. |
| `container-scan` | Container Vulnerability Scan | `ci.yml` | **Yes** | The image builds, and Trivy reports no unfixed `CRITICAL` or `HIGH` OS or library finding. |
| `container-smoke` | Container Smoke Build | `container-smoke.yml` | **Yes** | The image builds from a clean checkout with no local cache, dependency drift is rejected, the shipped image carries its runtime artifacts and no dev-only dependencies or environment files, and the documented liveness probe exists in the source. |
| `sensitive-changes-check` | Sensitive Changes Protection | `ci.yml` | No (advisory) | Reports whether auth, indexer, TypeORM migration, Prisma, database or CI-workflow paths changed. |

Recommended branch protection for `main`: require all six blocking jobs above, require them on
`pull_request` to `main` **and** on `push` to `main`, and disallow bypass except for
repository admins with an explicit dismissal reason.

## Triggers

Every workflow above runs on both events:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

This was already the case for `ci.yml` and is kept. `sensitive-changes-check` previously ran
only on `pull_request`; it now runs on both so that no job is silently absent from a push to
`main`, and it prints push-appropriate guidance instead of PR-only wording.

## Honesty properties of these gates

Verified by reading `.github/workflows/ci.yml` and `.github/workflows/container-smoke.yml` as
written. Not verified by executing them.

| Property | Status |
| --- | --- |
| `continue-on-error` | Not present in either workflow. |
| `\|\| true` | Not present in either workflow. |
| `exit 0` used to mask a failure | Not present in either workflow. `sensitive-changes-check` uses if/else branching rather than an early `exit 0`. |
| Unconditional success | No step ends in unconditional success. The only `if:` on a step is `if: always()` on the audit-evidence upload, which exists so the evidence is retained *when the audit step fails*. It does not suppress that failure: `npm audit` runs with `set -o pipefail` and still fails the job. |
| Conditional skip of a whole job | None. `sensitive-changes-check` used to carry `if: github.event_name == 'pull_request'`; that job-level condition is removed. |
| `permissions:` least privilege | Top level is `permissions: {}` (deny by default). Each job opts in. `security-events: write` is granted only to `security-scans`, which is the only job that uploads CodeQL results. Every other job receives `contents: read` and nothing more, which is the floor required by `actions/checkout`. |
| Deterministic installs | Every job that needs dependencies runs `npm ci`. The container builder stage runs `npm ci`. No job runs `npm install`. |
| Action pinning | Every `uses:` is pinned to a 40-character commit SHA with a `# vX.Y.Z` comment. See below. |

## Action pins

All action references are pinned to immutable commit SHAs. The SHAs below were resolved from
the GitHub API against each repository's release tags, not from memory.

| Action | Reference in workflow | SHA | Version comment |
| --- | --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | tag `v7.0.1` (was `v7`) | `# v7.0.1` |
| `actions/setup-node` | `820762786026740c76f36085b0efc47a31fe5020` | tag `v7.0.0` (was `v7`) | `# v7.0.0` |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | tag `v4.6.2` | `# v4.6.2` |
| `github/codeql-action` | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` | tag `v4.38.2` (was `v4`) | `# v4.38.2` |
| `dorny/paths-filter` | `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d` | tag `v4.0.3` (was `v4`) | `# v4.0.3` |
| `trufflesecurity/trufflehog` | `4dd8831c5f12599465d4d45c3c447b4018a34c85` | tag `v3.97.9` (was `main`, a branch) | `# v3.97.9` |
| `aquasecurity/trivy-action` | `ed142fd0673e97e23eac54620cfb913e5ce36c25` | tag `v0.36.0` (was `master`, a branch) | `# v0.36.0` |

No action reference was left as a TODO. Every reference, including the two that were
previously pinned to mutable branches (`trufflehog@main`, `trivy-action@master`), was
resolved to a real release tag. A branch ref is a supply-chain risk: it is mutable, so
upstream can change the code a workflow runs without any change to this repository.

To re-pin after a Dependabot bump, or to pin something added later, resolve the SHA for real
rather than copying one from this table:

```bash
gh api repos/OWNER/REPO/git/ref/tags/TAG --jq '.object.sha'
# annotated tags resolve to a tag object; dereference once more:
gh api repos/OWNER/REPO/git/tags/SHA --jq '.object.sha'
```

## Relationship to other open work

This change overlaps existing issues and pull requests. It does not supersede them, and the
maintainer should reconcile rather than merge both.

| Reference | Overlap | Status here |
| --- | --- | --- |
| Issue **#395** | Also addresses the required CI gate set. | This change implements the gate set and publishes the job-name table. If #395 has in-flight work on the same jobs, prefer one implementation; do not merge both without reconciling. |
| PR **#443** | Touches the same gate set. | Not reviewed. The job names in this table are the ones a branch-protection rule should use; if #443 renames a job, update this table in that pull request. |
| Issue **#497** (memplethee-lab) | Owns `.github/codeql/config.yml` and a scheduled CodeQL workflow. | Deliberately not created or edited here, to keep the two pull requests mergeable. |
| Issue **#498** (memplethee-lab) | Owns the Dockerfile runner stage (`USER`, `HEALTHCHECK`) and `.dockerignore`. | Deliberately not touched. `container-smoke.yml` reports the current `Healthcheck`/`User` values in the step summary and emits a `::warning::` rather than gating on work this repository does not own. |
| Issue **#392** | Mandates Prisma-only persistence convergence, the opposite of issue #517. | Unresolved direction. See `PRISMA_INVENTORY.md`. |
| Issue **#518**, **#516**, **#517** | Landed in the same pull request as this one. | `DEPENDENCY_SECURITY.md`, `DEPLOYMENT.md` and `PRISMA_INVENTORY.md` respectively. |

## Known failure expected on first run

`schema-migration-gate` is expected to fail on its first run.
`src/config/data-source.ts` imports `typeorm-naming-strategies`, which is not declared in
`package.json` and not present in `package-lock.json`, so the data source cannot load and
`npm run migration:run` cannot run. See "Known blocker in this gate" in `PRISMA_INVENTORY.md`
for the one-line fix.

This is the intended outcome of replacing a gate that tested dead code with one that tests
the real schema path. The previous step exercised Prisma and could not have surfaced the
defect.
