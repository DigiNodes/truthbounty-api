# Deployment Operations

This document covers the configuration, artifact validation, and deployment operations for the TruthBounty V2 Backend.

## Security and Integrity Guidelines

> [!IMPORTANT]
> The backend acts as a high-performance indexer and interface, but smart contracts remain the ultimate authority.
> Do NOT use or commit production secrets in deployment templates or examples.

## Supported Runtime and Toolchain

The API is built and deployed on exactly one Node major version. The declaration lives in
`package.json` under `engines`, and the `Node/npm Toolchain` CI job asserts that the runner
matches it, so drift between the declaration and the pipeline fails the build.

| Component | Supported range | Source of truth |
| --- | --- | --- |
| Node.js | `>=20 <21` (Node 20 LTS) | `package.json` → `engines.node` |
| npm | `>=10 <11` (npm 10) | `package.json` → `engines.npm` |
| Lockfile format | `lockfileVersion: 3` | `package-lock.json` |

npm 10 is the version bundled with Node 20 and is the version that writes `lockfileVersion: 3`.
A different npm major must not be used to install: it can rewrite the lockfile, which turns a
reproducible install into a silent dependency change.

```bash
# Confirm the local toolchain matches the supported ranges before doing anything else
node --version   # expect v20.x
npm --version    # expect 10.x
```

Install dependencies with `npm ci` only. `npm ci` installs the exact tree recorded in
`package-lock.json` and fails when `package.json` and the lockfile disagree, which is what
makes container builds and CI runs reproducible. Use `npm install` only when intentionally
changing dependencies, and commit the resulting lockfile in the same commit.

## Pre-Deployment Setup

### Configuration

Required environment keys are validated at startup by `EnvironmentValidationService` (`src/config/environment-validation.service.ts`).
Startup fails if a required key is missing or still a placeholder value. Other keys are documented in `.env.example`.
Generate your `.env` from `.env.example` and populate it with
environment-specific values.

```bash
# Example command for setting up configuration
cp .env.example .env
# Edit .env using your secure vault solution
```

The canonical environment keys are:

| Key | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `development`, `test`, `staging`, or `production` |
| `PORT` | yes | HTTP listen port |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_HOST` | yes | Redis host |
| `REDIS_PORT` | yes | Redis port (1-65535) |
| `JWT_SECRET` | yes | At least 32 characters; placeholders are rejected |
| `JWT_EXPIRATION` | yes | Access token lifetime |
| `REFRESH_TOKEN_EXPIRATION` | yes | Refresh token lifetime |
| `SIWE_DOMAIN` | yes | Domain used for Sign-In with Ethereum |
| `IPFS_GATEWAY_URL` | yes | IPFS gateway endpoint |
| `IPFS_API_URL` | yes | IPFS API endpoint |
| `CHAIN_ID` | yes | EVM chain ID; must match the release manifest |
| `RPC_URL` | yes | JSON-RPC endpoint; redacted in logs |
| `CONTRACT_RELEASE_MANIFEST_PATH` | yes | Path to the versioned canonical release manifest |
| `CONTRACT_RELEASE_STRICT` | see `.env.example` | Fail closed when release data is absent or inconsistent; must be true in staging and production |
| `CONTRACT_RELEASE_ID` | see `.env.example` | Expected release ID; must match the manifest |
| `CONTRACT_RELEASE_CHAIN_ID` | see `.env.example` | Expected chain ID; must match the manifest (Optimism = 10) |
| `CONTRACT_RELEASE_DEPLOYMENT_BLOCK` | see `.env.example` | Expected deployment block; must match the manifest |
| `LOCAL_DEV_MODE` | no | Must be `true` to allow an empty indexer configuration |
| `CONTRACT_RELEASE_MAX_AGE_DAYS` | no | Maximum manifest age in days (default 90) |
| `LOG_REDACT_KEYS` | no | Extra keys to redact in logs; RPC URLs and secrets are always redacted |


### Contract Release Manifest

Addresses, events and deployment blocks are not hand-maintained in `.env`. They are read
from the versioned canonical release manifest produced by the contract release package.
The manifest is validated at startup for:


- chain ID matching `CHAIN_ID`,
- release ID presence and format,
- deployment block presence and monotonicity,
- address format and checksum,
- ABI/event checksums,
- manifest age against the configured maximum age.




In `staging` and `production` the process fails closed when required release data is absent,
stale, or inconsistent. Local development must set `LOCAL_DEV_MODE=true` and is visibly
labelled as non-production in startup logs.

The API and the frontend both read the same manifest and expose the release ID and
checksums through the `/health` endpoint, so an operator can prove they consume the same
release.

Startup logs redact `RPC_URL` credentials and any value matching `LOG_REDACT_KEYS`; never
log the raw manifest contents or connection strings.


## Deployment Steps

### 1. Artifact Validation
Before deploying, ensure that the Docker image or generated binaries match the expected checksums and have passed all CI security gates (dependency SBOM and high-severity audit, Trivy, CodeQL, etc.). The dependency SBOM is generated from `package-lock.json` with development dependencies omitted, so it describes the production API dependency set.


```bash
# Generate `artifacts/dependency-sbom.cdx.json` and fail on high or critical advisories
npm ci
npm run security:dependencies

# Example validation using Trivy locally
trivy image --exit-code 1 --severity CRITICAL,HIGH truthbounty-api:<TAG>
```

The CI workflow uploads the CycloneDX SBOM as `dependency-sbom-<commit SHA>`. Treat a missing SBOM, an SBOM generation error, or a failed audit as a release blocker. Do not substitute an SBOM from another commit; regenerate it from the exact source and lockfile revision being deployed.

### 2. Database Migrations
Always run database migrations before spinning up the application to ensure schema consistency. Note that the database is non-authoritative compared to the chain, but must be in sync with the ORM.

TypeORM is the persistence layer for the application schema. Migrations live in `src/migrations/`
and are driven by the data source at `src/config/data-source.ts`, which selects PostgreSQL
when `DATABASE_URL` is set and falls back to SQLite only for local development and tests. Staging and production must set `DATABASE_URL`.

```bash
# Run pending migrations
npm run migration:run

# Roll back the most recent migration, for example when a bad release shipped one
npm run migration:revert
```

Do not use `npx prisma migrate deploy` for the application schema. It operates on
`prisma/schema.prisma`, which describes a separate, legacy data set; see
`PRISMA_INVENTORY.md` for the full picture of the two persistence layers.

### 3. Application Startup
Start the application using Docker Compose or your preferred orchestrator (e.g., Kubernetes).

```bash
# Start via Docker Compose
docker-compose up -d
```

Before the process accepts traffic, startup validates the environment schema and the
release manifest. If validation fails in `staging` or `production`, the process exits
non-zero and does not serve requests.

### 4. Indexer Bootstrap
For fresh deployments or rebuilds, trigger the indexer to sync from the authoritative chain.

The start block must be greater than or equal to the deployment block recorded in the
release manifest. An empty indexer configuration is only accepted when `LOCAL_DEV_MODE=true`.

```bash
# Backfill from a block at or after the manifest deployment block (authorization rules: docs/API_AUTHORIZATION_MATRIX.md)
curl -X POST http://localhost:3000/indexer/backfill -H "Content-Type: application/json" -d '{"contractAddress":"<CONTRACT_ADDRESS>","blockNumber":<BLOCK_NUMBER>}'
```

### 5. Staging Deployment Smoke Tests (V2-BE-146)
Immediately after staging is deployed, run the smoke suite against the live
instance. It probes `/health/live`, `/health/ready`, `/health/startup`,
`/health`, `/health/dependencies`, and `/health/indexer`, validating both HTTP
status codes and the payload contract the deployment must honour. It fails
closed: timeouts, malformed payloads, unhealthy status, or a missing version
all fail the suite.

```bash
# Locally, against any deployed instance:
STAGING_BASE_URL=https://staging.example.com npm run smoke:staging

# With a custom per-probe timeout:
STAGING_BASE_URL=https://staging.example.com SMOKE_TIMEOUT_MS=5000 npm run smoke:staging
```

- The suite is also run by the `Staging Deployment Smoke Tests` workflow
  (`.github/workflows/staging-smoke.yml`) either on a schedule or manually.
- The staging URL is read from the `staging_base_url` repository secret; it is
  never committed and never required to build or test locally.
- A failing probe is an observable, actionable failure. Do not ship a staging
  environment whose smoke suite does not pass.

See `STAGING_SMOKE_TESTS.md` for the endpoint-by-endpoint contract.

## Rollback Procedures

If a deployment fails or introduces regressions:

1. **Revert Image Version:** Rollback to the previous stable Docker tag in your orchestrator.
2. **Revert Migrations:** If the database schema was modified, restore from the pre-deployment snapshot (see `DISASTER_RECOVERY.md`).
3. **Restart Indexer:** Ensure the indexer is running and in sync with the chain.
4. **Verify Release Id:** Confirm the API and frontend report the same release ID and checksums via `/health`.
