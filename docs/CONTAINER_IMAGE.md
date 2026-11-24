# Production Container Runtime Contract

> **Scope.** This document describes the *runtime* contract of the TruthBounty
> API production image: who it runs as, how its health is determined, what it
> listens on, and which environment variables it expects **by name only**.
> It never contains a value, a secret, or a production address.
>
> Related: [`STATIC_ANALYSIS.md`](./STATIC_ANALYSIS.md) (CI-side security
> gates), [`DEPLOYMENT.md`](./DEPLOYMENT.md) (operator-facing rollout steps).

---

## 1. Why the runner stage is hardened

The image is an **indexer and read surface for a financial protocol**. The
deployed Optimism/EVM contracts are the only authority for protocol truth, and
the API is deliberately not authoritative for settlement, rewards, or dispute
outcomes. That design is only trustworthy if the process that serves it is
itself a minimal, non-privileged, well-observed artifact. Three specific
risks are addressed here:

| Risk | Control |
| ---- | ------- |
| A container escape or RCE lands with root inside the container | Dedicated non-root `USER`, no login shell, UID/GID 1001 |
| A developer's local `.env` (or any env variant) is baked into a published layer | `.dockerignore` excludes `.env` / `.env.*` from the **build context** |
| A silently wedged process keeps "running" while serving nothing | `HEALTHCHECK` against the route the app actually serves |

---

## 2. Runtime contract

| Property | Value |
| -------- | ----- |
| Base image | `node:20-alpine` |
| Working directory | `/app` |
| Runtime user | `truthbounty` (group `truthbounty`, UID/GID `1001`, shell `/sbin/nologin`) |
| Privileged | No. `USER truthbounty` is declared before `HEALTHCHECK` and `CMD`, so every subsequent instruction — and anything a future layer executes — runs unprivileged. |
| Exposed port | `3000` (override with `PORT`) |
| Healthcheck | `GET http://127.0.0.1:${PORT:-3000}/health/live` |
| Entrypoint | `npm run start:prod` → `node dist/main` |
| Files copied in | `package.json`, `package-lock.json`, `node_modules`, `dist`, `src/generated` |
| Files **not** copied in | source tree, `prisma/`, `contracts/`, tests, docs, `.env*` |

### 2.1 Why the UID is not a bare number

The account is created with `adduser`/`addgroup` and a name, not with a bare
`USER 1001`. A numeric `USER` has no passwd entry, no group ownership, and no
shell, which makes `docker exec` debugging and file-ownership reasoning
needlessly hard, and can silently collide with whatever UID the host has
mapped into the container. `1001` is chosen because it sits in the
unprivileged range and does not collide with the `node` account already
present in `node:20-alpine`.

`node_modules` is intentionally **not** `chown`ed. The application only ever
reads from it; leaving it root-owned with default `0755` permissions means a
compromised process cannot drop a shim into its own resolution path.

### 2.2 The real health endpoint

The `HEALTHCHECK` is wired to the route the application genuinely serves, read
off the source rather than assumed:

- `src/health/health.controller.ts` declares
  `@Controller('health')` + `@Public()` with `@Get('live')`.
- `src/main.ts` sets **no** global routing prefix (`app.setGlobalPrefix` does
  not appear anywhere in `src/`), so the effective path is `/health/live`.
- `@Public()` is honoured by `src/auth/global-auth.guard.ts` via
  `IS_PUBLIC_KEY`, so **no bearer token is required** — which is what makes it
  safe to probe from inside the container without embedding a credential in
  the image. (`GlobalAuthGuard` would also allow a `GET` through
  unauthenticated, but the explicit `@Public()` is the contract we rely on.)

`/health/live` is a **liveness** probe: `HealthService.getLiveness()` returns
`{ status: 'alive', timestamp, uptime }` from memory only, with no dependency
checks.

The probe deliberately does **not** use `/health/ready` or `/health` (the
aggregated report). Those run the full dependency set in
`HealthService.runChecks()` — Postgres, the BullMQ `jobs-queue`, IPFS upload,
and the blockchain/indexer state — and return `503` when a *critical*
dependency is down. Wiring `HEALTHCHECK` to a readiness endpoint would let
Docker's restart policy kill a process that is alive and behaving exactly as
designed, turning a database blip into a crash loop and discarding in-flight
work. Use `/health/ready` as a **Kubernetes readinessProbe** and
`/health/live` as a **livenessProbe**; that separation is the point of having
both routes.

The probe is implemented with `node -e` rather than `wget`/`curl` so it adds
no package to the image and runs on the exact interpreter serving traffic.
`--start-period=40s` covers cold start (module init, TypeORM connection).

### 2.3 The healthcheck must pass with no environment file

`.dockerignore` removes every `.env*` from the build context, so the container
starts with an empty environment unless the operator supplies one. The
`HEALTHCHECK` reads only `PORT` and defaults it, so the probe is functional in
that state. Any *other* missing variable is the application's business, not
the probe's — see §3.

---

## 3. Expected environment variables (names only)

Copy `.env.example` to `.env` locally, or supply the variables through your
orchestrator's secret store. **Values are never committed, never baked into
the image, and never printed here.** The table lists names and purpose only.

| Variable | Purpose | Notes |
| -------- | ------- | ----- |
| `NODE_ENV` | Runtime mode. Set to `production` in the image. | Already baked in; do not override to `development`. |
| `PORT` | HTTP listen port. Image exposes `3000`. | Healthcheck follows this value. |
| `DATABASE_URL` | PostgreSQL connection string. **Required** in production. | Without it the datasource falls back to a local SQLite file, which a non-root user cannot create. Fail fast is the intended outcome. |
| `DATABASE_SYNCHRONIZE` | Schema auto-sync. | Leave `false`; migrations are the supported path. |
| `DATABASE_LOGGING` | SQL logging toggle. | `false` in production. |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | Individual PG settings, as an alternative to `DATABASE_URL`. | Prefer `DATABASE_URL`. |
| `DB_SSL`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED` | TLS to PostgreSQL. | Enable for managed PG. |
| `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT`, `DB_POOL_ACQUIRE_TIMEOUT`, `DB_POOL_RETRIES`, `DB_POOL_RETRY_DELAY` | Connection-pool tuning. | Defaults documented in `src/config/data-source.ts`. |
| `JWT_SECRET` | Signs wallet-auth JWTs. **Required.** | Never ship the `.env.example` placeholder. |
| `JWT_EXPIRATION` | Token lifetime. | e.g. `7d`. |
| `TRUSTED_PROXIES` | Comma-separated proxy IPs. | Empty ⇒ `trust proxy` disabled. |
| `REDIS_ENABLED`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_TLS` | Redis / BullMQ connection. | Required for the notification outbox relay. |
| `BLOCKCHAIN_RPC_URL`, `OPTIMISM_RPC_URL`, `CHAIN_ID` | Optimism RPC endpoint and chain id. | Carry provider credentials; do not bake them in. |
| `REWARD_CONTRACT_ADDRESS` | Deployed contract to index. | Real address from the deployment record, never a dummy. |
| `START_BLOCK`, `REQUIRED_CONFIRMATIONS`, `CONFIRMATIONS_REQUIRED`, `BLOCK_RANGE_PER_BATCH`, `MAX_RETRY_ATTEMPTS`, `POLLING_INTERVAL_MS` | Indexer pacing and finality lag. | Finality lag is what keeps projections off unfinalized chain state. |
| `INDEXED_CONTRACTS` | JSON array of contract/event index configuration. | Empty array ⇒ indexer idle. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Notification email delivery. | Secrets via the orchestrator, not the image. |
| `NOTIFICATION_QUEUE_DELAY`, `NOTIFICATION_MAX_RETRIES`, `NOTIFICATION_RETRY_DELAY` | Outbox relay pacing. | |
| `CACHE_CLAIMS_TTL`, `CACHE_VERSION` | Redis cache tuning. | Bump `CACHE_VERSION` when cache shape changes. |
| `RATE_LIMIT_*` | Per-route throttling. | |
| `REALTIME_*` | SSE/outbox publisher tuning. | |
| `SYBIL_MIN_CLAIMS_FOR_ACCORACY_SCORE` | Sybil resistance floor. | |
| `BLOCKCHAIN_MAX_BLOCKS`, `BLOCKCHAIN_MAX_EVENTS`, `BLOCKCHAIN_MAX_REORG_HISTORY` | In-memory state caps (OOM guard). | |

`src/config/data-source.ts` and `src/config/blockchain.config.ts` are the
authoritative readers; this table is a convenience summary and can drift.
When in doubt, follow the code.

---

## 4. What is deliberately **not** in the image

| Excluded | Why |
| -------- | --- |
| Source (`src/**` except `src/generated`) | Only `dist` is executed. Source would be dead weight at best and a map of internals at worst. |
| `prisma/` schema + migrations | Migrations are run by the deploy pipeline against the live database, not from inside the app image. |
| `.env`, `.env.*` | Excluded from the **build context** by `.dockerignore`, so it cannot enter a layer or a layer cache. `.env.example` is kept deliberately: names only, no values. |
| `node_modules` from the host | Always rebuilt in the builder stage against the pinned lockfile. |
| `dist` from the host | Same — a host build may not match the image's platform or libc. |
| `database.sqlite`, `dev.db` | Developer state. Not runtime input. |
| Tests, coverage, docs | Not runtime input. |

---

## 5. Known gaps and follow-ups

These are **not** fixed by this change and are recorded so they are not lost.

1. **Builder stage still uses `npm install`, not `npm ci`.** Owned by the
   parallel PR (#516). It was deliberately left untouched here so the two
   changes merge cleanly. Until it lands, the builder can drift from
   `package-lock.json` and produce a non-reproducible `node_modules`.
2. **Builder stage `prunes` in place.** `npm prune --production` mutates the
   builder's `node_modules`, which is then copied wholesale. `--omit=dev`
   during a dedicated install step would be cleaner, but that is also a
   builder-stage change.
3. **No digest pinning of the base image.** `node:20-alpine` is a floating
   tag. Pin to a digest (e.g. `node:20-alpine@sha256:...`) for reproducible
   and auditable builds; this needs a real digest and a Dependabot-compatible
   update path, so it is tracked rather than guessed.
4. **No read-only root filesystem declared.** `docker run --read-only` plus a
   writable tmpfs for `/tmp` is achievable because the app writes nothing to
   `/app`, but that is an orchestrator-level decision, not a Dockerfile one.
5. **`ContractArtifactsLoader` reads `config/contracts/release-artifacts.json`
   from the working directory**, a path that is neither present in the
   repository nor copied into the image. Today this is harmless: neither
   `ContractArtifactsLoader` nor `HealthDiagnosticsController` is registered as
   a provider or controller anywhere in `src/app.module.ts`, so it is dead
   code. **If either is ever wired up, the image will fail to start** until
   the release artifacts are mounted at that path.
6. **Startup requires a reachable PostgreSQL.** With no `DATABASE_URL`, the
   datasource falls back to SQLite at a relative path. Under a non-root user
   in a read-only `/app` that fails — intentionally, since silently serving
   from local state would contradict the non-authoritative-database rule in
   `docs/DEPLOYMENT.md`.

---

## 6. Verifying an image

```bash
# Runtime user and healthcheck are present
docker inspect --format '{{ .Config.User }} {{ json .Config.Healthcheck }}' truthbounty-api:<TAG>

# Nothing that looks like an env file made it into any layer
docker history --no-trunc truthbounty-api:<TAG> | grep -E '\.env' || echo "clean"

# The probe actually passes against a running container
docker exec truthbounty-api:<TAG> node -e "require('http').get('http://127.0.0.1:3000/health/live',r=>console.log(r.statusCode))"
```

None of the above was executed as part of the change that introduced this
document; the maintainer runs all image and CI verification.
