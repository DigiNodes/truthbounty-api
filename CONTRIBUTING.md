# 🤝 Contributing to TruthBounty API

Thank you for your interest in contributing! This guide will help you get started and ensure consistency across contributions.

---

## 📚 Overview

This project is a backend API built with:

- **NestJS (TypeScript)**
- **TypeORM** (the persistence layer for the application schema)
- **PostgreSQL** (production) with a **SQLite** fallback for local development
- **Jest for testing**

### Persistence and migrations

TypeORM is the persistence layer for the application schema. Entities live alongside their
feature modules, and migrations live in `src/migrations/`. The data source is
`src/config/data-source.ts`, which selects PostgreSQL when `DATABASE_URL` is set and falls
back to SQLite otherwise.

```bash
npm run migration:run       # Apply pending migrations
npm run migration:revert    # Roll back the most recent migration
npm run migration:generate  # Generate a migration after changing an entity
```

Two things to know before you touch the schema:

1. **CI enforces the migrations.** The `Schema Migration and Drift Gate` job in `ci.yml`
   applies every migration to an empty PostgreSQL database, then reverts and re-applies the
   latest one, then fails if the entities do not exactly match the migrated schema. Generate
   a migration whenever you change an entity; an unmigrated entity change fails the gate.
2. **A legacy Prisma layer still exists** and is *not* the application schema. It is retained
   for a set of identity, analytics, outbox and AI-assistant features. Do not run `prisma
   migrate` against it, and do not assume its tables describe the protocol schema. Read
   `docs/PRISMA_INVENTORY.md` before adding anything that touches it.

---

## ⚙️ Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/DigiNodes/truthbounty-api.git
cd truthbounty-api

# Use Node 20 LTS with npm 10 (see "Supported Runtime and Toolchain" in docs/DEPLOYMENT.md)
nvm use 20

# Install exactly what package-lock.json records
npm ci
```
