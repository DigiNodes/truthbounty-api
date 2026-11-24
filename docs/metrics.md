# AI Assistant Backend API — Security

## Guardrails (`SafetyGuardrailService`)

All checks run in `PromptOrchestrationService` before any provider call (content checks) or on the provider's raw output before persistence/return (canary-leak check).

1. **Prompt length limits** — `SendMessageDto.content` has `@MaxLength(4000)` (class-validator, enforced by the global `ValidationPipe`), plus a runtime re-check against `AI_MAX_PROMPT_LENGTH` (DTO decorators can't read `ConfigService`, so this is defense-in-depth).
2. **Conversation memory-window budget** — capped by `AI_MEMORY_WINDOW_MESSAGES` and `AI_MEMORY_WINDOW_TOKEN_BUDGET`; bounds how much prior conversation content is ever sent to a provider in one call.
3. **Redaction (`redact()`)** — regex-based detection of email, phone, credit-card-like digit runs, OpenAI-style secret keys (`sk-...`), AWS access keys (`AKIA...`), JWT-shaped strings, and PEM private-key blocks. Always applied before logging; optionally applied to *stored* message content via `AI_REDACT_BEFORE_STORE` (default off — conversation storage is already per-user access-controlled, and redacting stored content trades away conversational fidelity).
4. **Blocklist / prompt-injection heuristics (`checkContent()`)** — a configurable term list (`ai.config.ts`) plus request-side heuristics ("ignore previous instructions", "reveal your system prompt", etc.). A match short-circuits **before any provider call** — zero-cost, deterministic refusal, `Message.flagged=true`, `AiUsageLog.status='safety_blocked'`.
5. **Structural injection defense** — `SendMessageDto` has no `role` field at all; the server always assigns `role: 'user'`, and `PromptOrchestrationService.prepare()` is the *only* place that assembles the message array sent to a provider, with the system message always first. No caller-supplied content can become a system message.
6. **Canary-token leak detection** — a random per-request token is appended to the system prompt with an instruction never to output it. `containsCanaryLeak()` checks the provider's raw output for that token before it's ever persisted or returned; a match replaces the response with a safe refusal and flags `flagReason='prompt_leak_detected'`. This is the concrete, testable stand-in for "the assistant must never reveal its own configuration."

### Known limitations

These are regex/keyword-based heuristics, not an ML moderation model — they will miss paraphrased attacks and can false-positive on legitimate content that happens to match a blocklist term. They're one layer, not the only layer: the system prompt template also explicitly instructs the model to refuse instruction-reveal requests, as defense-in-depth for prompts the regex misses.

## Authorization (RBAC)

- Every AI-assistant route requires a valid JWT (`JwtAuthGuard`), including GETs — conversations are private per user and the app-wide "GET is public by default" convention (`GlobalAuthGuard`) is explicitly overridden here.
- `ConversationService.findOwned()` enforces per-user ownership on every conversation lookup; a conversation belonging to another user returns `404`, not `403`, to avoid confirming its existence to non-owners.
- `mode` gating: `moderation_assist` requires `moderator`/`admin`; `admin_analytics` requires `admin`. Enforced in `ConversationService.create()`.
- Knowledge-base writes (`POST`/`PATCH`/`DELETE /ai-assistant/knowledge-base`) and usage analytics (`GET /ai-assistant/analytics/usage`) require `RolesGuard` + `@Roles(...)`.
- An admin-only per-request provider override (`SendMessageDto.providerOverride`) is checked against the *requesting user's* role server-side (`AiProviderRouterService`), not client-trusted.

## Data handling

- AI conversation/message data lives in TypeORM (SQLite), referencing the Prisma `User` only by `userId: string` — no cross-ORM foreign key, so deleting a Prisma user doesn't cascade automatically into AI data (a documented gap, consistent with how other TypeORM feature modules relate to `userId`).
- `AiUsageLog` is append-only and outlives conversation deletion, by design — it's the audit trail for usage/billing/abuse investigation even after a user deletes their conversation history.
- The AI exception filter (`AiExceptionFilter`) never leaks raw internal error messages to clients — unrecognized errors return a generic message; the real error (redacted first) goes only to the server log.
- The response envelope's `requestId` is either reused from an upstream-set `request.id` or freshly generated — never derived from user input — so it's safe to log and return without leaking anything.

## Out of scope for this iteration

- No ML-based content moderation model (regex/keyword only, see limitations above).
- No cross-module notification/event emission on flagged content (BE-020 notification infrastructure doesn't exist yet in this repo — see the architecture doc's "Known gap" section).
- No per-conversation encryption at rest beyond the database's own storage guarantees.
