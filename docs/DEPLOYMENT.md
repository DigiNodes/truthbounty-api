# Deployment Operations

This document covers the configuration, artifact validation, and deployment operations for the TruthBounty V2 Backend.

## Security and Integrity Guidelines

> [!IMPORTANT]
> The backend acts as a high-performance indexer and interface, but smart contracts remain the ultimate authority.
> Do NOT use or commit production secrets in deployment templates or examples.

## Pre-Deployment Setup

### Configuration

Ensure your `.env` file is generated from `.env.example` and populated with appropriate environment-specific configurations.

```bash
# Example command for setting up configuration
cp .env.example .env
# Edit .env using your secure vault solution
```

## Deployment Steps

### 1. Artifact Validation
Before deploying, ensure that the Docker image or generated binaries match the expected checksums and have passed all CI security gates (Trivy, CodeQL, etc.).

```bash
# Example validation using Trivy locally
trivy image --exit-code 1 --severity CRITICAL,HIGH truthbounty-api:<TAG>
```

### 2. Database Migrations
Always run database migrations before spinning up the application to ensure schema consistency. Note that the DB is non-authoritative compared to the chain, but must be in sync with the ORM.

```bash
# Run pending migrations
npx prisma migrate deploy
```

### 3. Application Startup
Start the application using Docker Compose or your preferred orchestrator (e.g., Kubernetes).

```bash
# Start via Docker Compose
docker-compose up -d
```

### 4. Indexer Bootstrap
For fresh deployments or rebuilds, trigger the indexer to sync from the authoritative chain.

```bash
# Sync from genesis or safe block
npm run indexer:bootstrap -- --start-block <BLOCK_NUMBER>
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
