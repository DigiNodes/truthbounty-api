# Notification & Event Delivery Architecture

## Overview
The Notification & Event Delivery API serves as the central communication backbone for the TruthBounty ecosystem. It handles real-time and asynchronous notifications across all platform modules (claims, verifications, disputes, governance, rewards).

## Core Components

### 1. Event Queue
Built on **BullMQ (Redis)**, ensuring fault-tolerant, asynchronous processing of events.
- **Queue Name**: `notifications`
- **Retry Mechanism**: Exponential backoff (max 5 attempts, delays starting at 2s, 4s, 8s, 16s).

### 2. Preference Engine
Users define their notification preferences (`NotificationPreference` entity):
- **Channels**: `IN_APP`, `EMAIL`, `PUSH`, `WEBHOOK`
- **Categories**: `CLAIM`, `VERIFICATION`, `DISPUTEa, `GOVERNANCE`, `REWARD`, etc.
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

## Future Extensibility
The modular architecture permits drop-in integrations for SMS, Slack, Discord, Telegram, and AI-generated summaries without modifying the core queue processor.
