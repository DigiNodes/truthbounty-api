# PREWAVE-BE-127: Propagate Recipient Delivery Failures Implementation

## Overview

This document describes the implementation of PREWAVE-BE-127, which ensures that notification outbox events are only marked `DISPATCHED` when actual deliveries succeed. The processor now propagates per-recipient and per-channel delivery failures, tracks retry state for partial failures, and maintains provider-confirmed delivery evidence.

## Problem Statement

Previously, `NotificationProcessor` would catch per-recipient errors, record an error result, then unconditionally mark the `OutboxEvent` as `DISPATCHED` and return success. `NotificationOrchestrator.deliverNotification` would initialize a results object but never populate it, catching per-user errors without propagating failure information. This meant a processor could report a recipient as delivered and dispatch the outbox event even when every channel failed, was skipped, or was unavailable.

## Solution Architecture

### 1. Structured Delivery Outcomes

**File**: `src/notifications/delivery/delivery-outcome.ts`

Introduced comprehensive types to capture precise delivery outcomes:

- **`DeliveryOutcome` enum**: Five deterministic outcomes
  - `DELIVERED`: Provider confirmed delivery (with message ID)
  - `SKIPPED`: Not attempted (disabled, preferences, rate limits)
  - `RETRYABLE_FAILURE`: Transient error (timeout, unavailable)
  - `TERMINAL_FAILURE`: Permanent error (invalid recipient, bounced)
  - `CHANNEL_UNAVAILABLE`: Channel implementation not registered

- **`ChannelDeliveryOutcome`**: Per-channel delivery result
  - Captures outcome, timing, provider message ID, failure classification
  - Includes idempotency key and retry attempt number
  - Links delivery to provider confirmation evidence

- **`RecipientDeliveryResult`**: Aggregated result per recipient
  - Counts successful, skipped, retryable, terminal, and unavailable channels
  - Determines if recipient was successfully notified (any channel delivered)

- **`NotificationDeliveryResult`**: Notification-level result
  - Aggregates all recipient outcomes
  - Provides `shouldDispatch` flag (true only if at least one recipient succeeded)
  - Distinguishes complete failure from partial success

### 2. Orchestrator Updates

**File**: `src/notifications/services/notification-orchestrator.service.ts`

Updated `NotificationOrchestrator.deliverNotification` to:

1. **Return structured results** instead of empty object
   - Each `deliverToUser` call returns `ChannelDeliveryOutcome[]`
   - Each `deliverViaChannel` returns a single `ChannelDeliveryOutcome`

2. **Classify every outcome**
   - Success → `successOutcome` with provider message ID
   - Skipped → `skippedOutcome` with reason (disabled, invalid config, preferences)
   - Channel error → classified via `narrowDeliveryError`
     - Retryable disposition → `retryableFailureOutcome`
     - Terminal disposition → `terminalFailureOutcome`
   - Channel unavailable → `channelUnavailableOutcome`

3. **Preserve provider evidence**
   - Store `channelMessageId` from provider in outcome
   - Link to idempotency key for audit trail
   - Record in `DeliveryTracker` with provider confirmation flag

### 3. Processor Delivery Completion Logic

**File**: `src/notifications/services/notification-processor.service.ts`

Updated `NotificationProcessor.processJob` to:

1. **Consume structured delivery result** from orchestrator
   - Receives `NotificationDeliveryResult` with complete outcome details

2. **Determine outbox status** via `determineOutboxStatus`:
   - **DISPATCHED**: `shouldDispatch === true` (at least one recipient succeeded)
   - **RETRY**: Retryable recipients exist and retry budget not exhausted
   - **DEAD_LETTER**: No successes and (all terminal OR retry budget exhausted)

3. **Store delivery evidence in outbox metadata**
   - Serialize delivery result summary with per-recipient, per-channel outcomes
   - Preserve provider message IDs, failure kinds, and timestamps
   - Store retry state for partial failures

4. **Link provider-confirmed deliveries to outbox event**
   - Call `linkDeliveryEvidenceToOutbox` on DISPATCHED status
   - Creates audit trail connecting `DeliveryHistory` to `OutboxEvent`

### 4. Idempotency Protection for Provider-Confirmed Deliveries

**File**: `src/notifications/services/delivery-tracker.service.ts`

Enhanced `DeliveryTracker` to provide strongest guarantees for provider-confirmed deliveries:

1. **`checkIdempotency`**: Enhanced to check provider confirmation
   - Standard delivered status blocks retry (24-hour Redis TTL)
   - Provider-confirmed delivery (with `providerMessageId`) blocks retry permanently
   - Sets extended Redis TTL (7 days) for provider-confirmed

2. **`recordDelivery`**: Marks provider-confirmed deliveries
   - Stores `providerConfirmed: true` in metadata when `providerMessageId` present
   - Records `confirmedAt` timestamp
   - Sets long-lived Redis guard to prevent future retries

3. **Audit methods**:
   - `getProviderConfirmedDeliveries`: Query all provider-confirmed deliveries
   - `isProviderConfirmed`: Check if delivery has provider confirmation
   - `linkDeliveryToOutboxEvent`: Create bidirectional audit trail
   - `getDeliveriesByOutboxEvent`: Retrieve all deliveries for an outbox event

### 5. Retry State Management

**File**: `src/notifications/delivery/retry-state.ts`

Implemented granular retry state tracking:

1. **`NotificationRetryState`**: Complete retry state
   - Tracks specific channel-recipient pairs that need retry
   - Separates successful, terminal, and skipped recipients
   - Maintains attempt counts per channel-recipient pair
   - Includes idempotency keys for each retryable attempt

2. **Key functions**:
   - `extractRetryState`: Extract failed pairs from delivery result
   - `mergeRetryResult`: Update state after retry attempt
   - `removeSuccessfulRecipients`: Prevent duplicate delivery on retry
   - `getRetryableChannels`: Identify which channels need retry per recipient

3. **Storage**: Retry state persisted in `outboxEvent.metadata`
   - Enables recovery of retry state across worker restarts
   - Provides audit trail of retry progression
   - Allows reconstruction of partial failure history

### 6. Outbox State Transitions with Evidence

The outbox event state machine now reflects actual delivery outcomes:

```
PENDING → PROCESSING → DISPATCHED  (at least one recipient delivered)
                    ↓
                    → PENDING (retry, with updated retry state)
                    ↓
                    → DEAD_LETTER (all failed or retry budget exhausted)
```

**State transition rules**:

- **DISPATCHED**: Only when `deliveryResult.shouldDispatch === true`
  - At least one recipient successfully delivered to at least one channel
  - Metadata includes serialized delivery result with all outcomes
  - All provider-confirmed deliveries linked via `DeliveryTracker`

- **RETRY (back to PENDING)**: When retryable failures exist within budget
  - No successful deliveries yet
  - At least one retryable failure
  - Current retry count < max retries
  - Retry state extracted and stored in metadata
  - Retry count incremented

- **DEAD_LETTER**: When no more retries possible
  - No successful deliveries
  - Either all terminal failures OR retry budget exhausted
  - Metadata includes final delivery result and failure summary
  - `lastError` field contains human-readable failure summary

## Integration Tests

**File**: `src/notifications/services/notification-processor.integration.spec.ts`

Comprehensive test coverage for all acceptance criteria:

1. ✅ **All channels fail** → outbox NOT marked DISPATCHED
2. ✅ **Partial recipient success** → independent tracking of success/failure
3. ✅ **Channel unavailable/disabled** → never reported as provider-confirmed
4. ✅ **Retryable provider failure** → retry state retained and bounded
5. ✅ **Terminal provider failure** → explicit dead-letter without retry
6. ✅ **Successful provider-confirmed delivery** → correct status transition and idempotency

Additional edge cases tested:
- Mixed outcomes across multiple recipients
- Idempotent re-processing of dispatched events
- Retry budget exhaustion
- Complex multi-channel, multi-recipient scenarios

## Key Improvements

### Before PREWAVE-BE-127
- Orchestrator returned empty results object
- Processor unconditionally marked outbox as DISPATCHED
- No distinction between skipped, failed, and successful deliveries
- No retry state for partial failures
- No provider confirmation tracking
- No delivery evidence linked to outbox events

### After PREWAVE-BE-127
- ✅ Structured per-recipient, per-channel outcomes
- ✅ Outbox DISPATCHED only on actual success (`shouldDispatch` flag)
- ✅ Five deterministic outcome types (delivered, skipped, retryable, terminal, unavailable)
- ✅ Granular retry state with channel-recipient pair tracking
- ✅ Provider-confirmed deliveries with extended idempotency protection (7 days)
- ✅ Bidirectional audit trail linking deliveries to outbox events
- ✅ Retry budget enforcement per delivery, not per outbox event
- ✅ Comprehensive test coverage for all failure scenarios

## Deployment Considerations

1. **Database**: No schema changes required
   - Uses existing `metadata` JSONB column on `OutboxEvent`
   - Uses existing `metadata` JSONB column on `DeliveryHistory`

2. **Redis**: Extended TTLs for provider-confirmed deliveries
   - Standard idempotency: 24 hours
   - Provider-confirmed: 7 days (168 hours)

3. **Backward Compatibility**:
   - New code handles missing retry state gracefully
   - Old outbox events without delivery result metadata work as before
   - Gradual rollout safe (no breaking changes)

4. **Monitoring**:
   - Log `shouldDispatch` flag on every job completion
   - Track `deliveryResult.successfulRecipients` vs `totalRecipients`
   - Monitor retry state size in metadata
   - Alert on dead-letter events with `completeFailure` flag

5. **Performance**:
   - Parallel channel delivery preserved (`Promise.allSettled`)
   - Audit trail linking happens asynchronously after DISPATCHED
   - Retry state extraction is O(recipients × channels), typically small

## Dependencies

- ✅ #613: Canonical notification module wiring
- ✅ #799: Correct event-to-job mapping
- ✅ #792 & #793: Truthful provider delivery outcomes (via `narrowDeliveryError`)

## Non-Goals (Explicitly Out of Scope)

- ❌ Replacing the transactional outbox pattern
- ❌ Changing notification event recipient policy
- ❌ Mainnet deployment (candidate for Stellar Wave, activation maintainer-controlled)

## Files Modified

1. `src/notifications/delivery/delivery-outcome.ts` (new)
2. `src/notifications/delivery/retry-state.ts` (new)
3. `src/notifications/services/notification-orchestrator.service.ts`
4. `src/notifications/services/notification-processor.service.ts`
5. `src/notifications/services/delivery-tracker.service.ts`
6. `src/notifications/services/notification-processor.integration.spec.ts` (new)

## Acceptance Criteria Status

- ✅ Orchestrator returns complete per-user/per-channel results
- ✅ Processor does not mark failed or skipped deliveries as delivered
- ✅ Outbox state transitions reflect actual delivery outcomes
- ✅ Retries cannot duplicate already-confirmed deliveries
- ✅ Integration tests cover full, partial, retryable, and terminal failures

**Status**: ✅ **Complete and ready for review**
