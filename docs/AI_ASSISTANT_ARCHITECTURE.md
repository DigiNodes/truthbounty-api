# AI Assistant Backend API — Architecture

## Overview

The AI Assistant module (`src/ai-assistant/`) centralizes conversation management, protocol-knowledge retrieval, AI provider routing, safety enforcement, prompt orchestration, usage analytics, and monitoring for TruthBounty. It is advisory-only: it never executes protocol actions, signs transactions, or moves funds.

It is a self-contained NestJS feature module, registered in `src/app.module.ts` like any other feature module (`ClaimsModule`, `DisputeModule`, etc.), following the repo's established `src/<feature>/` layout rather than the (unused, dead) `src/modules/` tree.

## Module layout

```
src/ai-assistant/
  ai-assistant.module.ts
  entities/            TypeORM entities (Conversation, Message, ContextDocument, AiUsageLog)
  dto/                 class-validator request/query DTOs
  providers/            AiProvider interface, OpenAiProvider, MockProvider
  services/             ConversationService, ContextRetrievalService, SafetyGuardrailService,
                         PromptOrchestrationService, AiProviderRouterService,
                         UsageAnalyticsService, KnowledgeBaseService
  cache/                AiAssistantCache (Redis-backed)
  metrics/              AiMetricsService (prom-client)
  config/               ai.config.ts (registerAs('ai', ...)), prompt-templates.ts
  common/                response envelope interceptor + exception filter
  controllers/           AiConversationsController, AiStreamController,
                         AiKnowledgeBaseController, AiAnalyticsController
```

RBAC primitives (`@Roles()`, `RolesGuard`) live under `src/auth/` as new, generic infrastructure — not module-local — since they're reusable beyond this feature. They intentionally do **not** reuse the broken, unregistered `src/modules/sybil` role-guard scaffolding, which references files that don't exist in the repo.

## Data model

TypeORM entities, matching the repo's dominant storage pattern (most feature modules use TypeORM/SQLite; only identity/User/Wallet use Prisma). AI entities reference the Prisma `User` only by `userId: string` — no cross-ORM foreign key.

- **`Conversation`** — one per chat thread. `mode` (`general` / `moderation_assist` / `admin_analytics`) and `status` (`active` / `archived` / `deleted`).
- **`Message`** — one row per turn (`system` / `user` / `assistant`), with token counts, `citations` (JSON), `provider`/`model`, `flagged`/`flagReason`, `redacted`.
- **`ContextDocument`** — the knowledge-base corpus searched by `ContextRetrievalService` (category, tags, content, `isActive` soft-delete).
- **`AiUsageLog`** — append-only usage/audit log, deliberately **separate** from `Message`: it must survive conversation deletion, and it also records calls that never produced an assistant message (safety-blocked, rate-limited, provider errors).

## Provider abstraction

`AiProvider` (`providers/ai-provider.interface.ts`) is a minimal contract — `chat()`, `stream()`, `isAvailable()` — implemented by:

- **`MockProvider`** — deterministic, zero-network. Default provider (`AI_PROVIDER=mock`) so the app and its full test suite never require a real AI API key.
- **`OpenAiProvider`** — wraps the `openai` SDK, reading both `OPENAI_API_KEY` and `OPENAI_BASE_URL`, so it also works unmodified against local OpenAI-compatible servers (Ollama, vLLM, LM Studio).

`AiProviderRouterService` is the *sole* consumer of provider implementations — nothing else in the module calls a provider directly. It resolves the configured default (or an admin-only per-request override), checks a Redis-cached availability probe, and falls back to the other provider if the primary is unavailable or its call throws. Fallback responses carry `meta.fallback: true` in the response envelope.

## Prompt orchestration

`PromptOrchestrationService.prepare()` (shared by both the non-streaming `generateReply()` and the streaming `prepareStream()` paths) is the **single place** that assembles the message array sent to a provider:

1. `SafetyGuardrailService.checkContent()` — blocklist/injection-heuristic check; a match short-circuits before any provider call.
2. `ContextRetrievalService.search()` — keyword-ranked results from the knowledge base, category-weighted by conversation mode (e.g. `moderation_assist` boosts `moderation_policy`/`governance`).
3. Memory window — last N messages (`AI_MEMORY_WINDOW_MESSAGES`), trimmed from the oldest until under an estimated token budget (`AI_MEMORY_WINDOW_TOKEN_BUDGET`), cached in Redis and invalidated on every new message.
4. System prompt — selected from `config/prompt-templates.ts` by `(mode, role)`, with a per-request random canary token appended for leak detection (see Security doc).
5. Message order is always `[system, system-context?, ...memory, user]` — the request DTO has no `role` field, so no caller can inject a system message.

Prompt templates are code-owned (`config/prompt-templates.ts`), not a DB table — they're reviewed like any other source change. **Extension seam**: promote to a `PromptTemplate` TypeORM entity + admin CRUD (mirroring `ContextDocument`) if non-engineers need runtime editability later.

## Context retrieval (and its upgrade path)

No vector DB or embeddings pipeline exists in this repo. `ContextRetrievalService` does pragmatic keyword retrieval: tokenize the query (stopword-stripped), `LIKE`-match against `title`/`content`/`tags` via a TypeORM query builder (capped candidate pool), then score in application code (`titleMatch*3 + tagMatch*2 + contentMatch*1`, normalized to `[0,1]`).

**This is the documented seam to swap in real semantic search later**: `ContextRetrievalService.search()` is the only method callers use; replacing its internals with a vector-DB-backed implementation (pgvector, sqlite-vss, a hosted vector store) requires no changes to `PromptOrchestrationService` or any controller.

## Streaming

Two-phase design, to keep prompt content out of URLs/access logs and because `EventSource` (SSE) is GET-only with no request body:

1. `POST .../messages/stream` — runs safety checks, persists the user `Message`, caches a short-TTL pending marker, returns `{ messageId, streamUrl }`.
2. `GET .../stream/:messageId` (`@Sse()`) — verifies the pending marker + conversation ownership, resolves a provider, and streams `citation` → `chunk`* → `done`/`error` SSE events. The terminal event persists the assistant message, logs usage, invalidates the memory-window cache, and records metrics — exactly once, regardless of success/error/disconnect.

## Response envelope & error handling

`AiResponseEnvelope<T> = { success, requestId, timestamp, data, error, meta? }`, produced by `AiResponseInterceptor` on success and `AiExceptionFilter` on error — applied per-controller (`@UseInterceptors`/`@UseFilters`) on the three REST controllers, not globally (no such convention exists elsewhere in the repo) and not on the SSE controller (which uses its own event-shaped payload).

## RBAC

Minimal, generic role system added to support this feature: `role: UserRole` (`contributor` | `moderator` | `admin`) on the Prisma `User` model, `@Roles()` decorator + `RolesGuard` under `src/auth/`. `ConversationService` gates `mode` at creation time (`moderation_assist` requires moderator/admin, `admin_analytics` requires admin); `AiKnowledgeBaseController` writes and `AiAnalyticsController` are role-gated at the route level.

## Known gap: notifications (BE-020)

No `@nestjs/event-emitter` or webhook infrastructure exists anywhere in this repo, so BE-020 (Notification & Event Delivery API) cross-module integration is **not wired up** — this module doesn't block on infrastructure that doesn't exist yet. The seam for a future integration is `ConversationService.finalizeAssistantMessage()` / the streaming controller's terminal event, where an event emit would go once notification infra lands.

## Testing infrastructure note

e2e tests (`test/ai-assistant*.e2e-spec.ts`) run against a trimmed `AiAssistantTestModule` (`test/utils/ai-assistant-test.module.ts`) rather than the real `AppModule`, and against an isolated, throwaway Prisma database (`test/utils/prisma-test-db.helper.ts`) rather than the shared `dev.db`. See the "Pre-existing issues" section of `AI_ASSISTANT_OPERATIONS.md` for why.
