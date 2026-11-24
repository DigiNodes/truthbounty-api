# CI Approval & Fork Workflow Authorization (V2-BE-044)

This document explains the merge gates in `.github/workflows/ci.yml`, why every
result is non-skippable, and how approval works for security-sensitive changes.

## Merge Gates

Branch protection for `main` must require all of the following status checks:

1. **Build, Lint, and Test** — typecheck, `npm run build`, generated-artifact
   drift detection, ESLint, unit/integration tests (`npm run test:cov`), and
   migration validation.
2. **Security Scans** — `npm audit --audit-level=high`, TruffleHog secret
   scanning, and CodeQL (JavaScript/TypeScript).
3. **Container Vulnerability Scan** — Docker build followed by Trivy
   (OS + library, CRITICAL and HIGH).
4. **Sensitive Changes Protection** — fails closed unless the *exact* head SHA
   of the PR carries an `APPROVED` review when auth, indexer, database, V2
   protocol, Prisma, or CI files change.
5. **All Required Gates Passed** — the aggregation job; it fails if any of the
   gates above failed. Branch protection can require this single status.

## Non-Skippable Guarantees

- No required job uses `continue-on-error: true`; the explicit checks set it to
  `false` where the historical default could mask a failure.
- Nothing is skipped based on the branch, actor, or event that opened the PR.
- The **All Required Gates Passed** job uses `if: always()` so a *skipped*
  gate cannot hide a real failure — the aggregator still inspects every result
  and fails the run if any required job failed.

## Action Pinning

Every first- and third-party action is pinned to an immutable commit SHA with a
comment naming the release tag (e.g. `3d3c42e # v7`). Moving refs such as
`@main` or `@master` are not used anywhere in the workflow, so a compromised or
retroactively-mutated tag cannot change what runs in CI.

## Fork Workflow Authorization

- The workflow runs on the **`pull_request`** (base-ref-safe) event, so code
  proposed by forks executes with a **read-only** `GITHUB_TOKEN`: no secrets and
  no repository write access are available to unreviewed head commits.
- Secrets that staging or deployment workflows need are kept out of this file;
  anything requiring credentials uses explicit `secrets.*` references and the
  shortest permission scope.
- CI never writes to the repository. Approval is enforced by *reading* review
  state via the API, never by trusting the PR author's own commits.

## Approval Policy for Sensitive Paths

Sensitive means any change under `src/auth/`, `src/indexer/`, `src/database/`,
`src/v2/`, `prisma/`, or `.github/workflows/`.

- The **Sensitive Changes Protection** job detects those paths via
  `dorny/paths-filter`.
- When sensitive paths are touched, the job queries the PR's reviews and only
  passes when one review has state `APPROVED` **and** `commit_id` equals the
  PR's current `head.sha`.
- A push that lands after the approval changes `head.sha`, so the check fails
  and demands a *fresh* approval of the new head. This prevents fast-forward
  trust of stale reviews.

## Local Reproducibility

Each gate is reproducible on a Linux container with Node 20:

```sh
npm ci
npx tsc --noEmit --project tsconfig.build.json
npm run build
npx eslint "{src,apps,libs,test}/**/*.ts"
npm run test:cov
npx prisma migrate reset --force && npx prisma migrate deploy
docker build -t truthbounty-api:test .
```

The DB-backed checks run against the local SQLite/LibSQL dev database as
configured by `prisma.config.ts` and `.env`.
