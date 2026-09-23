# Staging Deployment Smoke Tests (V2-BE-146)

This document defines the health contract a deployed TruthBounty API must
satisfy, the smoke suite that validates it, and how to run it.

## Purpose

TruthBounty treats deployed contracts and canonical chain events as protocol
authority. The API is a deterministic indexing, projection, authentication, and
delivery layer. After a deployment the smoke suite proves the instance is alive,
ready, fully started, and reporting its dependencies — so a silently broken
staging environment can never be mistaken for a healthy one.

## Endpoint Contract

The suite (`src/scripts/staging-smoke.ts`) validates each endpoint below.

| Endpoint | Expected HTTP | Expected payload |
| --- | --- | --- |
| `GET /health/live` | 200 | `{ status: 'alive' }` |
| `GET /health/ready` | 200 | `{ ready: true }` |
| `GET /health/startup` | 200 | `{ startupComplete: true }` |
| `GET /health` | 200 | `status` is `healthy`, `version` non-empty |
| `GET /health/dependencies` | 200 | `status` is `healthy`, `dependencies` array |
| `GET /health/indexer` | 200 | `status` is **not** `unhealthy`; degraded is a fail only below 200 |

The `status` field must be one of `healthy`, `degraded`, or `unhealthy`. Any
`unhealthy` status, any non-200 where 200 is required, a malformed payload, a
missing `version`, a timeout, or a network error fails the suite.

## Failure Modes Covered

- Invalid/missing base URL (bad scheme, empty, malformed)
- Timeout per probe (default 10\,000 ms)
- Invalid JSON response
- Network unreachable
- Readiness reporting `unavailable` (502/503)
- Aggregate health `unhealthy`
- Missing deployment version
- Indexer `unhealthy` even under HTTP 200
- Liveness not reporting `alive`

## Running the Suite

```bash
# Full suite via npm script
STAGING_BASE_URL=https://staging.example.com npm run smoke:staging

# Custom timeout
STAGING_BASE_URL=https://staging.example.com SMOKE_TIMEOUT_MS=5000 npm run smoke:staging

# Directly
STAGING_BASE_URL=https://staging.example.com npx ts-node src/scripts/staging-smoke.ts
```

Exit code is `0` only when every probe passes; otherwise the failure reason per
probe is printed and the process exits non-zero.

## CI Hook

The `Staging Deployment Smoke Tests` GitHub workflow
(`.github/workflows/staging-smoke.yml`) runs the suite against the configured
staging URL:

- **Schedule:** every 4 hours.
- **Manual:** `workflow_dispatch` with an optional `base_url` input overrides
  the `staging_base_url` repository secret.
- **Secrets:** only the `staging_base_url` secret is read; the script itself
  reads no secrets and never writes credentials to logs or artifacts.

## Adding a Probe

Add a new entry to `smokeProbes` in `src/scripts/staging-smoke.ts` with a path
under the instance's public health surface, an `expectStatus`, and a `validate`
closure. Keep it minimal: the suite must never require an endpoint that is not
core to the deployment's health, and must never silently accept a degraded
instance.
