# AI Assistant Backend API — Operations Guide

## Durable paid-provider budgets

These controls apply to the currently wired `services/` path at
`/ai/conversations` and the new `/ai/budgets` routes. Paid calls reserve durable
allowance before dispatch. The provider/router fallback guidance in older
sections below does not describe this active path.

`AI_BUDGET_OPERATOR_IDS` is a comma-separated, distinct UUID allowlist of app
users permitted to mutate budgets. The default empty value denies all budget
operators. Each operator must also have the verified linked app role `admin`.
Neither role nor permission can be supplied in a request body.

| Route | Authenticated access | Body |
| --- | --- | --- |
| `GET /ai/budgets/me` | Current user only | None |
| `POST /ai/budgets/admin/prices` | Budget operator | Provider/model and integer nano-USD rates, `changeReference` |
| `POST /ai/budgets/admin/policies` | Budget operator | `rules`, `changeReference` |
| `POST /ai/budgets/admin/coverage` | Budget operator | `changeReference` |
| `POST /ai/budgets/admin/overrides` | Budget operator | User/window, finite token/spend bonuses, expiry, `changeReference` |
| `POST /ai/budgets/admin/overrides/:id/revoke` | Budget operator | `changeReference` |

Change references are reviewed ticket codes such as `OPS-818`, matching
`[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}`. Free-form reasons, prompts, payloads,
tokens and secrets are excluded from these bodies and audit records. UUID audit
references identify the operator, operation and result.

Prices use unsigned decimal strings `inputNanos`, `outputNanos`,
`cachedInputNanos`:1 USD=1000000000 nano-USD. Operators verify provider rates
before inserting a revision. New revisions select the current tariff; existing
attempts retain their original `priceVersion`. Revisions are append-only.
Embedding output rates must be zero; chat output rates must be positive; the
cached input rate cannot exceed the ordinary input rate. There are no shipped
production prices.

Each policy has at most32 rules:
`{scope, subject, window, tokenLimit, spendLimitUsdNanos}`. Amounts are canonical
unsigned decimal strings up to9000000000000000000. Windows are fixed UTC
`day` or `month`; zero limits deny paid requests. A default `user` rule with
subject `*`, a `global` rule with subject `*` and explicit `provider` rules
for `openai`/`anthropic` are required. Optional UUID user rules apply in addition
to the default. A provider missing an applicable rule fails closed. Token and
spend limits are checked together for every applicable rule; policy changes count
earlier revisions' usage rather than starting fresh counters.

The preflight token bound intentionally reserves the full input ceiling, plus
the output allowance:144384 for `gpt-4o-mini`,201024 for
`claude-3-haiku-20240307`,8192 for `text-embedding-3-small`.
Anthropic spend also reserves2x ordinary input pricing to cover unknown
cache-creation premiums. Set finite policy ceilings large enough for the supported
request bound. Complete actual usage releases the proven unused amount; unknown
usage retains its conservative quota charge. These amounts enforce internal
allowances and do not charge end users.

Overrides add at most1000000 tokens and100000000000 nano-USD ($100) to one user's
current day/month window. At least one bonus must be positive; at most one override
may be active for that user/window. Expiry must have an explicit timezone, be
after database time, and be within both24 hours and the current window end.
Bonuses apply only to user limits. Provider/global ceilings, missing prices,
coverage barriers and violation halts remain enforced. Expiry/revocation affects
new admissions; already dispatched consumption remains charged.

### Historical cutover and migration

Before enabling paid traffic, complete the maintainer's PostgreSQL/persistence
recovery (#896/#831) and canonical-path consolidation (#817). The baseline has
an invalid package manifest, transitional Prisma/LibSQL configuration and legacy
SQLite migration SQL; this contribution does not repair that separate history.

Apply the existing `PersistAdministrativeAudit1792200000000` and new
`DurableAiBudgets1795300000000` through the approved TypeORM datasource.
The new migration provisions a native PostgreSQL usage table if absent, preserves
existing IDs/dates/counts and leaves historical price/cost fields NULL. Runtime
and legacy CLI discovery use a re-export of the same migration class: execute
one discovery path once. The current `npm run migration:run` maps to Prisma and
does not apply these budget tables. After baseline recovery, the TypeORM CLI uses
`src/config/data-source.ts`; do not use automatic schema synchronization or
reset a production database.

1. Quiesce paid provider dispatch across every old replica and drain in-flight work.
   Preserve a read-only legacy usage snapshot with source identity, checksum and
   high-water mark. Keep earlier records; do not reprice them at today's tariff.
2. Deploy the version with the single forward TypeORM usage writer while paid
   admission is closed. Create verified price revisions and a finite policy.
3. Call the guarded coverage route with a reviewed change reference. It records
   locked database time once; repeated initialization is rejected.
4. Keep old replicas stopped. Wait until every applicable policy window starts
   at or after the recorded checkpoint. A monthly rule can require the next UTC
   month; a daily rule requires the next UTC day. Overrides cannot shorten this
   barrier. There is no historical-import bypass in this implementation.
5. Verify the migrated PostgreSQL runtime and enable paid traffic after the
   window drain. Relevant unknown/unpriced legacy PostgreSQL usage still fails
   admission rather than counting as zero.

A policy that later adds a longer window is subject to the same persisted coverage
checkpoint. Restarts, policy/price revisions and cache outages cannot create a
new baseline or discard charged attempts.

### Exhaustion, uncertainty and outage responses

Budget errors use the existing public error fields plus `state`, `resetAt` and
`retryAfterSeconds`. Only trusted budget exceptions pass this metadata.

| HTTP | Error code | Meaning |
| --- | --- | --- |
|429 | `AI_BUDGET_EXHAUSTED` | An allowance is exhausted; no provider request occurred. |
|422 | `AI_REQUEST_EXCEEDS_BUDGET` | The bound cannot fit an empty effective allowance; reset/retry fields are NULL. |
|503 | `AI_BUDGET_UNAVAILABLE` | PostgreSQL/schema/accounting unavailable; paid admission closed. |
|503 | `AI_BUDGET_POLICY_MISSING` / `AI_BUDGET_PRICE_MISSING` | Required operator configuration missing or invalid. |
|503 | `AI_BUDGET_ACCOUNTING_NOT_READY` | Coverage or longest-window drain incomplete. |
|503 | `AI_BUDGET_USAGE_UNPRICED` | Relevant historical usage has no reproducible price/actual usage. |
|503 | `AI_BUDGET_USAGE_BOUND_VIOLATED` | New paid admission halted following a provider-bound violation. |

For429, `resetAt` is the latest blocking UTC boundary across all scopes, calculated
using database time after the authority lock. A safe delay also appears in the
`Retry-After` header. The response contains no other user's or global/provider
remaining counters. A safe coverage reset may be returned for503.

Successful paid responses include `metadata.usageState`, `chargedTokens`,
`chargedSpendUsdNanos` and `priceVersion`. Missing/partial usage has
`tokens:null`, `usageState:held` and the retained bound. Local mock usage is
explicitly `mock` with NULL paid charges. Provider errors and process interruption
retain durable holds; no TTL or restart refunds them. Accounting failure never
retries or falls back to another provider.

On a violation or store outage, stop paid dispatch and investigate through
reviewed ledger/audit references. Policy activation cannot clear a violation halt.
Operational rollback keeps the ledger and disables dispatch. Reverting to an
older unbudgeted binary would resume untracked paid usage. The new migration
refuses destructive reversal once policies, prices, coverage, attempts, overrides
or priced usage exist.

### Maintainer verification

Regression specs cover policy/price/config validation, actual/unknown usage,
denial with zero SDK calls, expiry/revocation/audit rollback, canonical-route
HTTP responses, migration preservation and two-datasource PostgreSQL races,
restarts and settlement failures. Project tests/builds were not executed locally.
Run the budget PostgreSQL suite only against a disposable database using
`AI_BUDGET_POSTGRES_TEST_URL`. The existing administrative-audit PostgreSQL suite
uses `ADMIN_AUDIT_TEST_DATABASE_URL`. Both use random isolated schemas. A skipped
suite without its own explicit database URL is unverified. CI approval, runtime/coverage
and migration-history gates remain maintainer-owned.


## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `mock` | Shared provider selection with `DEFAULT_LLM_PROVIDER`: `openai`, `anthropic` or `mock`. Both names must agree when supplied. Deployed environments require an explicit real provider. |
| `DEFAULT_LLM_PROVIDER` | `mock` | Provider used by `LlmProviderService`; derived from `AI_PROVIDER` when only that is supplied. `mock` is rejected in staging/production. |
| `OPENAI_API_KEY` | _(unset)_ | Required in staging/production when the configured provider is `openai`. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Required in staging/production when the configured provider is `anthropic`. |
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

Set one provider name (`AI_PROVIDER` or `DEFAULT_LLM_PROVIDER`) and its matching API key. To use a local OpenAI-compatible server instead of hosted OpenAI, also set `OPENAI_BASE_URL` (e.g. `http://localhost:11434/v1` for Ollama). No other configuration changes needed — `AiProviderRouterService` picks up the change on next boot.

Startup fails in staging/production when the provider is missing, unsupported, set to `mock`, or lacks its API key. At request time, a missing or failing client returns an explicit `AI_PROVIDER_UNAVAILABLE` response; no fabricated mock text is ever substituted.

In local/test, `mock` returns output explicitly labelled as non-model output. In development it additionally requires `LOCAL_DEV_MODE=true`. Admin `providerOverride=mock` is restricted by the same rule.

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
