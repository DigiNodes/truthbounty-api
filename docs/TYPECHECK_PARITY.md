# Local, CI, and Container Type-Check Parity Contract

> **Scope.** This document specifies the enforcement of compiler configuration,
> source set coverage, generated prerequisites, and toolchain parity across local
> developer environments, hosted CI workflows, and production container builds.
> Introduced under **PREWAVE-BE-030** (issue #625), as a focused child of #584 and
> addressing disparity exposed by Gate B on draft PR #608.
>
> Related: [`CI_GATES.md`](./CI_GATES.md), [`CONTAINER_IMAGE.md`](./CONTAINER_IMAGE.md),
> [`NESTJS_BASELINE.md`](./NESTJS_BASELINE.md).

---

## 1. Problem Context

Hosted Gate B on draft PR #608 exposed an architectural discrepancy between build
paths in the repository:
1. **Container bypass**: The `Dockerfile` builder stage executed `npm run build`
   (`nest build`) without running `npm run type-check`.
2. **Container-only source exclusions**: `.dockerignore` previously excluded the
   `test/` directory, preventing the container from verifying contract and e2e test
   types.
3. **Disparate tsconfig compilation**: Local and CI executions of `tsc --noEmit`
   evaluated `tsconfig.json`, whereas container and local emit builds evaluated
   `tsconfig.build.json` with differing source inclusion boundaries.
4. **Implicit generated prerequisites**: Prisma client generation was executed ad-hoc
   in `Dockerfile` (`npx prisma generate`) but was not deterministically bound to
   `prebuild` or CI verification before type-checking.
5. **Silent version drift**: Discrepancies between host Node/npm/compiler versions
   and the pinned engine baseline (`Node >=20 <21`, `npm >=10 <11`, `TypeScript 6.0.3`)
   could produce divergent compiler errors across environments without actionable
   diagnostics.

---

## 2. Parity Architecture

To guarantee that a broken source fixture fails all three paths with the exact same
compiler error set, all three paths compile against the unified contract:

```
+-------------------------------------------------------------------------+
|                       UNIFIED TSCONFIG & SOURCE SET                     |
|                   tsconfig.json: include ["src/**/*", "test/**/*"]     |
+-------------------------------------------------------------------------+
             |                               |                          |
             v                               v                          v
     [ 1. Local Build ]             [ 2. Hosted CI Gate ]       [ 3. Container Build ]
  npm run build                 ci.yml (build-and-test)      Dockerfile (builder stage)
  -> prebuild:                  -> generate:prerequisites    -> generate:prerequisites
     - generate:prerequisites   -> parity:check              -> type-check
     - type-check (tsc)         -> type-check (tsc)          -> build
  -> nest build                 -> build
```

### 2.1 The Three Build Paths

| Build Path | Command / Execution Point | Generated Prerequisites | Type Check Step | Source Set Included |
| ---------- | ------------------------- | ----------------------- | --------------- | ------------------- |
| **Local Build** | `npm run build` | `npm run prebuild` (`generate:prerequisites`) | `npm run prebuild` (`type-check`) | `src/**/*`, `test/**/*` |
| **Hosted CI** | `.github/workflows/ci.yml` | `npm run generate:prerequisites` | `npm run type-check` | `src/**/*`, `test/**/*` |
| **Container Build** | `Dockerfile` (builder stage) | `RUN npm run generate:prerequisites` | `RUN npm run type-check` | `src/**/*`, `test/**/*` |

---

## 3. Prevention of Source Exclusions

- **`.dockerignore` parity**: `test` is deliberately **not** ignored in `.dockerignore`.
  This allows the container's builder stage to compile and type-check the full source
  and test tree.
- **Stage Isolation**: Multi-stage isolation preserves runtime security. The final
  `runner` image copies only runtime production artifacts (`dist`, `node_modules`,
  `src/generated`). Test sources, fixtures, and build cache never cross the stage
  boundary into the shipped image.
- **`tsconfig.json` scoping**: `tsconfig.json` explicitly declares `include: ["src/**/*", "test/**/*"]`
  and excludes `node_modules`, `dist`, and non-API smart contract directories (`contracts`).

---

## 4. Generated Prerequisites Lifecycle

Prisma client code generation (`src/generated/client`) is a required prerequisite for
TypeScript compilation because `src/prisma/prisma.service.ts` imports model types and
enums from the generated client:

- **Canonical script**: `npm run generate:prerequisites` (`prisma generate`).
- **Deterministic binding**: Automatically wired to `pretype-check` and `prebuild` in
  `package.json`.
- **Drift detection**: Hosted CI runs `npm run generate:prerequisites` and verifies
  `git status --porcelain` after `npm run build` to fail closed if uncommitted
  schema/client drift is present.

---

## 5. Toolchain and Compiler Parity Guard

The diagnostic tool `scripts/parity-report.mjs` enforces version compliance without
external runtime dependencies.

### 5.1 Enforced Invariants

| Component | Pinned Version / Constraint | Authority Source | Actionable Diagnostic on Drift |
| --------- | --------------------------- | ---------------- | ------------------------------ |
| **Node.js** | `>=20 <21` (major 20) | `package.json` `engines.node` | Directs operator to switch to Node 20 (`nvm use 20` or Docker). |
| **npm** | `>=10 <11` (major 10) | `package.json` `engines.npm` | Directs operator to align npm version to 10.x. |
| **TypeScript** | `6.0.3` (exact lock) | `package.json` / `package-lock.json` | Directs operator to run `npm ci` to restore pinned compiler. |
| **Prerequisites**| `src/generated/client/client.ts` | `prisma/schema.prisma` | Directs operator to execute `npm run generate:prerequisites`. |
| **Docker Parity** | No `test` exclusion in `.dockerignore`; `RUN npm run type-check` in Dockerfile | Repository security baseline | Alerts on container-only bypass or source exclusion. |

### 5.2 Usage

```bash
# Print human-readable parity diagnostics report
npm run parity:report

# Enforce parity checks (fails with exit code 1 if drift detected)
npm run parity:check

# Machine-readable JSON output
node scripts/parity-report.mjs --json
```

---

## 6. Security and Sanitization Constraints

1. **Diagnostics Sanitization**: `scripts/parity-report.mjs` output never reflects or
   logs environment variables containing tokens, secrets, private keys, database
   passwords, or bearer authorizations.
2. **Fail-Closed Verification**: Missing compiler configurations or broken prerequisite
   trees fail immediately rather than continuing with degraded checks.
3. **Supply-Chain Integrity**: Pinned dependencies and frozen lockfile verification
   from #584 remain strictly preserved.
