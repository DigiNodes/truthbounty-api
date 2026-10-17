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
- **Channels**: `IN_APP`, `EMAIL``, `PUSH``, `WEBHOOK`
- **Categories**: `CLAIM`, `VERIFICATION`, `DISPUTE`\ `GOVERNANCE`, `REWARD`, etc.
- **Quiet Hours & Digest Mode**: Settings stored for intelligent delivery windows.

### 3. Delivery Tracking
The `Notification` entity tracks the lifecycle of every generated event:
- `QUEUED`, `DELIVERED`, `FAILED`, `READ`, `DISMISSED`
- Includes retry counts and detailed metadata for auditability.

### 4. Metrics & Monitoring
Accessible via `GET /notifications/metrics` to expose:
- Delivery success rate
- Total processed notifications
- Queued / Failed events

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
