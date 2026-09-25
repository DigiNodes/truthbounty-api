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

TypeORM is the persistence layer for the application schema. Migrations live in `src/migrations/`
and are driven by the data source at `src/config/data-source.ts`, which selects PostgreSQL
when `DATABASE_URL` is set and falls back to SQLite when it is not.

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

### 4. Indexer Bootstrap
For fresh deployments or rebuilds, trigger the indexer to sync from the authoritative chain.

```bash
# Sync from genesis or safe block
npm run indexer:bootstrap -- --start-block <BLOCK_NUMBER>
```

## Rollback Procedures

If a deployment fails or introduces regressions:

1. **Revert Image Version:** Rollback to the previous stable Docker tag in your orchestrator.
2. **Revert Migrations:** If the database schema was modified, restore from the pre-deployment snapshot (see `DISASTER_RECOVERY.md`).
3. **Restart Indexer:** Ensure the indexer is running and in sync with the chain.
