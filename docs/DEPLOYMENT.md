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

## Rollback Procedures

If a deployment fails or introduces regressions:

1. **Revert Image Version:** Rollback to the previous stable Docker tag in your orchestrator.
2. **Revert Migrations:** If the database schema was modified, restore from the pre-deployment snapshot (see `DISASTER_RECOVERY.md`).
3. **Restart Indexer:** Ensure the indexer is running and in sync with the chain.
