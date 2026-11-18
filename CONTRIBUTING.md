# 🤝 Contributing to TruthBounty API

Thank you for your interest in contributing! This guide will help you get started and ensure consistency across contributions.

---

## 📚 Overview

This project is a backend API built with:

- **NestJS (TypeScript)**
- **TypeORM** (the persistence layer for the application schema)
- **PostgreSQL** as the selected persistence target; Prisma/LibSQL remains transitional
- **Jest for testing**

### Persistence and migrations

**Selected target:** TypeORM + PostgreSQL. Entities live alongside feature modules,
and the TypeORM migration history lives in `src/migrations/`. The TypeORM CLI
datasource (`src/config/data-source.ts`) is PostgreSQL-only and has
`synchronize: false`.

**Important current-state warning:** the application is not yet TypeORM-only.
`AppModule` still registers `PrismaModule`, and `PrismaService` still uses the
LibSQL adapter. The runtime schema defines `DATABASE_URL` as PostgreSQL, so the
current Prisma adapter/configuration contract is inconsistent. Do not treat a
successful TypeScript build as proof of database runtime readiness.

Use the explicitly named TypeORM CLI commands only against a disposable PostgreSQL
database while the two migration histories are being reconciled:

```bash
npm run typeorm:migration:show
npm run typeorm:migration:run
npm run typeorm:migration:revert
npm run typeorm:migration:generate -- src/migrations/DescribeChange
```

The legacy `migration:*` scripts still invoke Prisma. They are retained for
compatibility while Prisma-backed services remain active; they are not TypeORM
commands. Do not run either migration path against a shared or production database
until its schema history and data-parity plan have been independently reviewed.

CI currently runs Prisma migration commands and does **not** yet prove that the
TypeORM migration history can initialize PostgreSQL. See
`docs/PERSISTENCE_CONVERGENCE.md` for the phased migration and release gates.

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
