# Notification & Event Delivery Architecture

## Overview
The Notification & Event Delivery API serves as the central communication backbone for the TruthBounty ecosystem. It handles real-time and asynchronous notifications across all platform modules (claims, verifications, disputes, governance, rewards).

## Core Components

### 0. Outbound Webhook Delivery (PREWAVE-BE-059)
Outbound webhooks are signed, versioned, and idempotent. Every delivery is bound to canonical finalized contract events and to chain/release/artifact provenance; delivery fails closed on stale, ambiguous, unauthorized, or incomplete state.

### 1. Event Queue
Built on **BullMQ (Redis)**, ensuring fault-tolerant, asynchronous processing of events.
- * *Queue Name**: `notifications`
- **Retry Mechanism**: Exponential backoff (max 5 attempts, delays starting at 2s, 4s, 8s, 16s).

### 2. Preference Engine
Users define their notification preferences (`NotificationPreference` entity):
- **Channels**: `IN_APP`, `EMAIL`, `PUSH`, `WEBHOOK`
- **Categories**: `CLAIM`, `VERIFICATION`, `DISPUTE`, `GOVERNANCE`, `REWARD`, etc.
- **Quiet Hours & Digest Mode**: Settings stored for intelligent delivery windows.

#### Quiet-Hours Timezone Handling

Quiet hours are evaluated as wall-clock `HH:mm` windows in the user's stored
IANA timezone using the platform's built-in `Intl.DateTimeFormat` — not
`moment-timezone`, which this service no longer depends on:

- **Zero new runtime dependencies.** Node.js ships full ICU data, so
  `Intl.DateTimeFormat` resolves any IANA zone with no additional package,
  keeping the install graph deterministic (see the install-determinism work
  tracked by #584/#608).
- **Maintained implementation.** moment is in maintenance mode; the Intl API
  is maintained by the Node.js project and tracks IANA releases with the
  runtime.
- **Deterministic under DST.** Wall-clock minutes are derived per instant from
  the zone database, so spring-forward and fall-back transitions evaluate
  consistently (see the DST cases in `preference-enforcer.service.spec.ts`).

Boundary rule (minute granularity): a same-day window `[start, end]` is
inclusive of both boundary minutes; an overnight window (start > end) covers
`[start, 24:00) ∪ [00:00, end)`. An invalid timezone falls back to UTC with a
warning; malformed `HH:mm` values evaluate as not-quiet so delivery is never
blocked by a timing error. The canonical preference-level boundary rules are
tracked separately by #616.

### 3. Delivery Tracking
The `Notification` entity tracks the lifecycle of every generated event:
- `QUEUED`, `DELIVERED`, `FAILED`, `READ`, `DISMISSED`
- Includes retry counts and detailed metadata for auditability.

### 4. Metrics & Monitoring
Accessible via `GET /notifications/metrics` to expose:
- Delivery success rate
- Total processed notifications
- Queued / Failed events

Prometheus series are emitted on the shared `GET /metrics` endpoint via
`prom-client` (no separate metrics library): `notifications_sent_total`,
`notifications_delivered_total`, `notifications_failed_total`,
`notifications_retried_total` (labels: `channel`, `event_type`, plus `reason`
on failures), and `notification_delivery_duration_seconds` (label: `channel`).
Labels are constrained to closed allow-lists — channel and event type come
from their canonical enums, and free-text failure reasons are normalized to a
fixed taxonomy. No user, wallet, email, claim, or secret value ever becomes a
label. Metrics can be disabled only through the explicit `METRICS_ENABLED`
mode (default enabled).

## Event Type Templates

Every `EventType` in the canonical event model has an explicit, reviewed template for each render target (subject, body, HTML, Markdown). The template registry is typed as an exhaustive `Record<EventType, EventTemplate>`, so adding a new `EventType` without a template fails compilation.

### Moderation Event Naming

Moderation events use the canonical `MODERATION_ACTION` event type across code, storage, API, and documentation. The legacy `MODERATOR_ACTION` name is deprecated; incoming legacy payloads are normalized to `MODERATION_ACTION` at the event boundary before persistence or dispatch. No duplicate compatibility model is maintained.

Legacy migration is explicit and versioned: a single normalization function maps the deprecated `MODERATOR_ACTION` identifier to `MODERATION_ACTION` at intake, and any other unrecognized event type is rejected rather than coerced. The normalization is covered by compatibility tests that assert legacy payloads persist and dispatch as `MODERATION_ACTION` and that unknown types fail closed.

### Unknown Event Types

Template resolution fails closed. An event whose type is not present in the canonical `EventType` union is rejected at intake and is never rendered with a default or fallback template.

### Escaping and Variables
Placeholders are filled from event payloads treated as untrusted input. Values are escaped for the target channel: HTML escaping for `HTML` bodies, Markdown escaping for `Markdown` bodies, and plain-text sanitization for subjects and text bodies. Missing template variables cause rendering to fail closed rather than emitting partial output.

#### Stored HTML templates (`TemplateRenderer`)
- Markup in a stored `htmlTemplate` is authored, trusted content and is kept as written.
- Every `{{variable}}` value interpolated into `htmlTemplate` is untrusted. It is HTML-escaped (`&`, `<`, `>`, `"`, `'`), so it renders as text in both element-text and quoted-attribute positions.
- When a value is the start of an `href` or `src` attribute, it must also pass `sanitizeActionUrl`; otherwise the attribute is left empty.
- There is no trusted-HTML escape hatch for interpolated values: event context can never inject markup.
- `actionUrl` returned by the renderer, and the call-to-action link built by the email channel, go through `sanitizeActionUrl`. It allows only `http:`, `https:`, `mailto:` and root-relative `/path` URLs, and rejects `javascript:`, `data:`, other schemes, protocol-relative `//host` URLs, and values containing whitespace, backslashes or control characters.
- Subject, plaintext body and Markdown output are not HTML-escaped by the renderer.

## Future Extensibility
The modular architecture permits drop-in integrations for SMS, Slack, Discord, Telegram, and AI-generated summaries without modifying the core queue processor.

## Outbound Webhook Contract (PREWAVE-BE-059)

### Envelope
All outbound webhook payloads use a versioned envelope. The envelope version is stable per event type and bumped only on breaking changes.
- `version`: envelope schema version (e.g. `v1`).
- `event`: canonical finalized contract event type.
- `deliveryId`: stable, deterministic identifier for one logical event (see Idempotency).
- `timestamp`: Unix epoch seconds at signing time.
- `provenance`: `{ chainId, releaseId, artifactDigest }` binding the event to chain/release/artifact provenance.
- `data`: event-specific payload.

### Signature, Timestamp, Delivery ID
- Every request carries `X-Webhook-Signature`, `X-Webhook-Timestamp`, and `X-Webhook-Delivery-Id` headers.
- Signature is an HMAC over `version + "." + timestamp + "." + deliveryId + "." + rawBody` using the endpoint's active signing key.
- Signing keys are versioned and rotatable; the active key ID is sent in `X-Webhook-Key-Id`. Receivers must support overlapping key rotation windows.
- Receivers verify integrity and reject replays outside the configured timestamp tolerance.

### Idempotency
- `deliveryId` is derived deterministically from the canonical event identity (event type, chain, release, artifact, and event key) so one logical event always has the same delivery identity across retries.
- Receivers are expected to deduplicate on `deliveryId`.

### Retry Policy
- Retries are bounded: max 5 attempts with exponential backoff (2s, 4s, 8s, 16s).
- Retries reuse the same `deliveryId`; only `timestamp` and signature are refreshed.
- Retries stop on 2xx. 4xx (except 408/429) are treated as terminal. 5xx, timeouts, and redirects are retried within the bound.
- Redirects are not followed; a redirect response is treated as a delivery failure.

### Endpoint Validation (SSRF)
- Endpoints must be HTTPS and resolve to public addresses; loopback, link-local, private, and metadata ranges are rejected.
- DNS is re-resolved at delivery time to prevent rebinding; unsafe targets are rejected and recorded.
- Endpoint changes require re-validation before delivery resumes.

### Audit History
- Every attempt records delivery ID, endpoint, status, latency, response class, key ID, and outcome.
- Audit history is retained for verification and is queryable per endpoint and per delivery ID.

### Required Tests
- Receiver timeout, 2xx/4xx/5xx handling, redirect rejection, duplicate delivery, key rotation, SSRF target rejection, and bounded retry behavior.
## Module convergence and truthful delivery outcomes (PREWAVE-BE-018)

- Exactly one production notification module is registered:
  `src/notifications/notifications.module.ts`. The duplicate
  `notifications.module.new.ts`, the legacy `notification.module.ts`
  (which imported the non-existent `@instanct/nestjs/common` package and a
  missing `notification.service`), and its `notification.controller.ts` and
  `notification.processor.ts` have been removed.
- The production worker is `src/notifications/services/notification.processor.ts`
  on the `notifications` queue. No second consumer or provider is registered.
- Email delivery resolves the recipient from the user's notification
  preferences (`NotificationPreferencesService.getUserPreferences().emailAddress`).
  There is no placeholder fallback: an unresolved recipient fails closed with
  `No verified recipient email on record`.
- A missing email provider is a failure (`Email provider not configured`), not a
  simulated success. A delivery row is marked `DELIVERED` only after a
  provider-confirmed send; `NotificationService.processDelivery()` records
  attempts as `PENDING` and never claims delivery on its own.
- Push remains explicitly unimplemented and is reported as `FAILED` with
  `Push notifications not implemented`, so it can never be recorded as
  delivered.
