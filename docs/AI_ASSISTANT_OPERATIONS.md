# AI Assistant Backend API — Operations Guide

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `mock` | `openai` or `mock`. Defaults to `mock` everywhere so the app and its tests never require a real key. |
| `OPENAI_API_KEY` | _(unset)_ | Required only when `AI_PROVIDER=openai`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at a local OpenAI-compatible server (Ollama/vLLM/LM Studio) to run without a hosted OpenAI account. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default model for the OpenAI provider. |
| `AI_MAX_PROMPT_LENGTH` | `4000` | Runtime re-check backing the DTO's `@MaxLength`. |
| `AI_MEMORY_WINDOW_MESSAGES` | `10` | Max prior messages considered for conversation memory. |
| `AI_MEMORY_WINDOW_TOKEN_BUDGET` | `3000` | Estimated-token cap for the memory window (oldest trimmed first). |
| `AI_CONTEXT_TOP_N` | `5` | Max knowledge-base citations per reply. |
| `AI_CONTEXT_CACHE_TTL` | `900` (s) | Context-retrieval result cache TTL. |
| `AI_CONVO_WINDOW_CACHE_TTL` | `120` (s) | Conversation memory-window cache TTL. |
| `AI_PROVIDER_AVAILABILITY_CACHE_TTL` | `30` (s) | How long a provider's availability probe result is trusted before re-checking. |
| `AI_REDACT_BEFORE_STORE` | `false` | If `true`, redact detected PII/secrets from *stored* message content (logs are always redacted regardless). |
| `RATE_LIMIT_AI_TTL` / `RATE_LIMIT_AI_LIMIT` | `60` / `10` | Non-streaming chat throttle window/limit. |
| `RATE_LIMIT_AI_STREAM_TTL` / `RATE_LIMIT_AI_STREAM_LIMIT` | `60` / `3` | Streaming throttle window/limit (stricter). |

## Switching providers

Set `AI_PROVIDER=openai` and `OPENAI_API_KEY`. To use a local OpenAI-compatible server instead of hosted OpenAI, also set `OPENAI_BASE_URL` (e.g. `http://localhost:11434/v1` for Ollama). No other configuration changes needed — `AiProviderRouterService` picks up the change on next boot.

If the configured primary provider is unavailable (network error, bad key), requests automatically fall back to the other provider and the response envelope carries `meta.fallback: true`. Availability checks are cached for `AI_PROVIDER_AVAILABILITY_CACHE_TTL` seconds to avoid probing on every request.

## Seeding the knowledge base

```
npm run seed:ai            # inserts sample documents (one per category), skips if a title already exists
npm run seed:ai -- --clear # wipes ai_context_documents first
```

Documents can also be managed at runtime via `POST/PATCH/DELETE /ai-assistant/knowledge-base` (moderator/admin only).

## Metrics

Registered directly on the shared prom-client default registry, so they appear on the existing `GET /metrics` with no separate endpoint:

| Metric | Type | Labels |
|---|---|---|
| `ai_requests_total` | Counter | `provider`, `endpoint`, `status` (`success`\|`error`\|`fallback`\|`safety_blocked`) |
| `ai_request_duration_seconds` | Histogram | `provider`, `endpoint` |
| `ai_tokens_total` | Counter | `provider`, `type` (`prompt`\|`completion`) |
| `ai_provider_availability` | Gauge | `provider` (1 = available, 0 = unavailable) |
| `ai_cache_hits_total` / `ai_cache_misses_total` | Counter | `cacheType` |
| `ai_rate_limited_total` | Counter | `throttleType` (`ai`\|`aiStream`) |

Cache hit ratio isn't stored directly (a gauge/counter can't correctly represent a ratio over time) — compute it at query time:

```promql
rate(ai_cache_hits_total[5m]) / (rate(ai_cache_hits_total[5m]) + rate(ai_cache_misses_total[5m]))
```

## Rate-limit tuning

`RATE_LIMIT_AI_*`/`RATE_LIMIT_AI_STREAM_*` follow the same pattern as the repo's existing `claims`/`votes`/`disputes` throttle types (`src/config/throttler.config.ts`). The guard tracks by `x-wallet-address` header/body/query, falling back to IP — it's a defense layer, not the source of conversation-level authorization (that's `@CurrentUser()` + ownership checks in `ConversationService`).

## Provider-outage runbook

1. Check `ai_provider_availability{provider="..."}` — `0` means the last probe failed.
2. Check `ai_requests_total{status="fallback"}` — rising fallback rate means the primary is degraded but the secondary is absorbing traffic; no user-facing outage.
3. Check `ai_requests_total{status="error"}` — both providers failing simultaneously. Verify `OPENAI_API_KEY`/`OPENAI_BASE_URL` and network egress.
4. `MockProvider` never fails, so if `AI_PROVIDER=mock` requests are erroring, the issue is elsewhere in the request pipeline (safety check, DB, cache), not provider connectivity.

## Pre-existing repo issues discovered while building this feature

These predate the AI Assistant work (confirmed via `git status` showing the files untouched) and were either fixed (where they blocked this feature directly) or worked around (where fixing them was out of scope):

- **Fixed** — `prisma/schema.prisma`'s datasource declared `provider = "postgresql"` while the actual runtime driver (`src/prisma/prisma.service.ts`) is `@prisma/adapter-libsql` (SQLite), and `prisma/migrations/migration_lock.toml` already recorded `"sqlite"`. Under the package-lock-pinned `prisma@7.4.1`, this mismatch throws `PrismaClientInitializationError` at runtime for *any* Prisma-backed request (i.e. every authenticated endpoint in the app, not just AI). Changed the datasource `provider` to `"sqlite"` to match reality.
- **Fixed** — `src/metrics/metrics.service.ts` used `import client from "prom-client"`, which resolves to `undefined` under this project's `esModuleInterop`/ts-jest configuration (prom-client's CJS build has no default export) — `MetricsModule` would crash the whole app at startup. Switched to named imports (`import { Counter, Histogram, register } from "prom-client"`), the same fix already applied in this module's own `AiMetricsService`.
- **Not fixed (out of scope)** — `prisma/migrations/` never added a `walletAddress` column to `User`, even though `schema.prisma` has required it (`@unique`) since the initial migration. The committed `dev.db` fixture reflects this gap (6 existing rows, no `walletAddress` column) — adding the column now requires a full SQLite table rebuild with a real backfill decision (e.g. which of a user's linked wallets becomes `User.walletAddress`), which isn't this ticket's call to make. AI-assistant e2e tests route around it via an isolated, `prisma db push`-provisioned throwaway database (`test/utils/prisma-test-db.helper.ts`) rather than the shared `dev.db`.
- **Not fixed (out of scope)** — `DisputeController` calls `DisputeService`'s create/resolve/reject/findAll methods with stale positional arguments; the service was refactored to accept single DTO objects but the controller wasn't updated. This alone blocks `AppModule` from compiling under `ts-jest`'s e2e config (confirmed by running the pre-existing, untouched `test/auth.e2e-spec.ts` through the same config). `DisputeService.expireDispute()` also references `DisputeStatus.EXPIRED`, which doesn't exist in the `DisputeStatus` enum. AI-assistant e2e tests use a trimmed test-only module (`test/utils/ai-assistant-test.module.ts`) that excludes `DisputeModule` (and `ClaimsModule`/`IdentityModule`/`JobsModule`, which fail to compile for unrelated reasons — corrupted source in `evidence.service.ts`/`identity.service.ts`/`jobs.service.ts`) entirely, rather than depending on their correctness.

None of the "not fixed" items affect the AI Assistant module's own correctness — they're pre-existing gaps in unrelated modules, flagged here so they aren't mistaken for something this change introduced.
