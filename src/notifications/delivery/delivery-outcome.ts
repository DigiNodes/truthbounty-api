import { DeliveryChannel } from '../interfaces/notification.types';
import { DeliveryFailureKind, RetryDisposition } from './delivery-error';

/**
 * Precise terminal outcome for a single channel-recipient delivery attempt.
 *
 * Every delivery produces exactly one of these outcomes; the orchestrator and
 * processor must never report a recipient as successfully delivered when the
 * actual outcome was skipped, failed, or retryable.
 */
export enum DeliveryOutcome {
  /**
   * Provider confirmed the message was delivered (e.g., email accepted by MTA,
   * push notification acknowledged, in-app record persisted).
   */
  DELIVERED = 'DELIVERED',

  /**
   * Delivery was not attempted because the channel was disabled, user preferences
   * blocked it, or quiet hours/rate limits prevented it. Not an error.
   */
  SKIPPED = 'SKIPPED',

  /**
   * Delivery failed with a retryable error (timeout, provider unavailable, rate
   * limit). The processor should retry this channel-recipient pair.
   */
  RETRYABLE_FAILURE = 'RETRYABLE_FAILURE',

  /**
   * Delivery failed with a terminal error (invalid recipient, malformed payload,
   * permanent bounce). The processor must not retry this pair.
   */
  TERMINAL_FAILURE = 'TERMINAL_FAILURE',

  /**
   * Channel implementation is not registered or available in the orchestrator.
   * Terminal; cannot be resolved by retry.
   */
  CHANNEL_UNAVAILABLE = 'CHANNEL_UNAVAILABLE',
}

/**
 * Complete result for a single channel delivery attempt to a single recipient.
 *
 * Carries the precise outcome, timing, error details, and provider-specific
 * evidence that links the delivery to external confirmation (message ID, tracking
 * token, etc.). The processor uses these results to decide whether to mark the
 * outbox event DISPATCHED or retry/dead-letter the job.
 */
export interface ChannelDeliveryOutcome {
  /** Which channel was used (or attempted). */
  channel: DeliveryChannel;

  /** Deterministic outcome for this channel-recipient pair. */
  outcome: DeliveryOutcome;

  /** When the attempt was made. */
  attemptedAt: Date;

  /** When delivery was confirmed (only for DELIVERED outcome). */
  deliveredAt?: Date;

  /** Provider-specific message ID for tracking and idempotency. */
  providerMessageId?: string;

  /** Failure kind (only for RETRYABLE_FAILURE or TERMINAL_FAILURE). */
  failureKind?: DeliveryFailureKind;

  /** Retry disposition (only for failure outcomes). */
  disposition?: RetryDisposition;

  /** Human-readable reason for skip or failure. */
  reason?: string;

  /** Error message (only for failure outcomes). */
  errorMessage?: string;

  /** Current retry attempt number (0-based). */
  retryAttempt?: number;

  /** Idempotency key used to prevent duplicate deliveries. */
  idempotencyKey?: string;
}

/**
 * Aggregated delivery result for a single recipient across all enabled channels.
 *
 * The processor uses this to determine per-user success/failure and to decide
 * which channel-recipient pairs need retry. A recipient is considered successfully
 * notified if at least one channel produced a DELIVERED outcome.
 */
export interface RecipientDeliveryResult {
  /** User ID of the recipient. */
  userId: string;

  /** All channel attempts for this recipient. */
  channels: ChannelDeliveryOutcome[];

  /** Was at least one channel successfully delivered? */
  succeeded: boolean;

  /** Number of channels that delivered successfully. */
  successCount: number;

  /** Number of channels that were skipped. */
  skippedCount: number;

  /** Number of channels that failed with a retryable error. */
  retryableFailureCount: number;

  /** Number of channels that failed with a terminal error. */
  terminalFailureCount: number;

  /** Number of channels that were unavailable. */
  unavailableCount: number;
}

/**
 * Complete delivery result for all recipients across all channels.
 *
 * Returned by `NotificationOrchestrator.deliverNotification` and consumed by
 * `NotificationProcessor` to decide the outbox event's final state. The processor
 * must not mark an event DISPATCHED if no recipients were successfully delivered.
 */
export interface NotificationDeliveryResult {
  /** Per-recipient outcomes. */
  recipients: RecipientDeliveryResult[];

  /** Total number of recipients. */
  totalRecipients: number;

  /** Number of recipients with at least one successful channel delivery. */
  successfulRecipients: number;

  /** Number of recipients with all channels skipped or unavailable. */
  skippedRecipients: number;

  /** Number of recipients with at least one retryable failure and no success. */
  retryableRecipients: number;

  /** Number of recipients with only terminal failures. */
  terminalRecipients: number;

  /** Was at least one recipient successfully notified? */
  anySuccess: boolean;

  /** Did every recipient fail or get skipped (no success at all)? */
  completeFailure: boolean;

  /** Should the processor mark the outbox event DISPATCHED? */
  shouldDispatch: boolean;
}

/**
 * Create a ChannelDeliveryOutcome for a successful delivery.
 */
export function successOutcome(
  channel: DeliveryChannel,
  providerMessageId?: string,
  idempotencyKey?: string,
): ChannelDeliveryOutcome {
  return {
    channel,
    outcome: DeliveryOutcome.DELIVERED,
    attemptedAt: new Date(),
    deliveredAt: new Date(),
    providerMessageId,
    idempotencyKey,
  };
}

/**
 * Create a ChannelDeliveryOutcome for a skipped delivery.
 */
export function skippedOutcome(
  channel: DeliveryChannel,
  reason: string,
): ChannelDeliveryOutcome {
  return {
    channel,
    outcome: DeliveryOutcome.SKIPPED,
    attemptedAt: new Date(),
    reason,
  };
}

/**
 * Create a ChannelDeliveryOutcome for a retryable failure.
 */
export function retryableFailureOutcome(
  channel: DeliveryChannel,
  failureKind: DeliveryFailureKind,
  errorMessage: string,
  retryAttempt: number = 0,
  idempotencyKey?: string,
): ChannelDeliveryOutcome {
  return {
    channel,
    outcome: DeliveryOutcome.RETRYABLE_FAILURE,
    attemptedAt: new Date(),
    failureKind,
    disposition: 'retryable',
    errorMessage,
    retryAttempt,
    idempotencyKey,
  };
}

/**
 * Create a ChannelDeliveryOutcome for a terminal failure.
 */
export function terminalFailureOutcome(
  channel: DeliveryChannel,
  failureKind: DeliveryFailureKind,
  errorMessage: string,
  idempotencyKey?: string,
): ChannelDeliveryOutcome {
  return {
    channel,
    outcome: DeliveryOutcome.TERMINAL_FAILURE,
    attemptedAt: new Date(),
    failureKind,
    disposition: 'terminal',
    errorMessage,
    idempotencyKey,
  };
}

/**
 * Create a ChannelDeliveryOutcome for an unavailable channel.
 */
export function channelUnavailableOutcome(
  channel: DeliveryChannel,
  reason: string,
): ChannelDeliveryOutcome {
  return {
    channel,
    outcome: DeliveryOutcome.CHANNEL_UNAVAILABLE,
    attemptedAt: new Date(),
    reason,
  };
}

/**
 * Aggregate channel outcomes into a single recipient result.
 */
export function aggregateRecipientResult(
  userId: string,
  channels: ChannelDeliveryOutcome[],
): RecipientDeliveryResult {
  const successCount = channels.filter(
    (c) => c.outcome === DeliveryOutcome.DELIVERED,
  ).length;
  const skippedCount = channels.filter(
    (c) => c.outcome === DeliveryOutcome.SKIPPED,
  ).length;
  const retryableFailureCount = channels.filter(
    (c) => c.outcome === DeliveryOutcome.RETRYABLE_FAILURE,
  ).length;
  const terminalFailureCount = channels.filter(
    (c) => c.outcome === DeliveryOutcome.TERMINAL_FAILURE,
  ).length;
  const unavailableCount = channels.filter(
    (c) => c.outcome === DeliveryOutcome.CHANNEL_UNAVAILABLE,
  ).length;

  return {
    userId,
    channels,
    succeeded: successCount > 0,
    successCount,
    skippedCount,
    retryableFailureCount,
    terminalFailureCount,
    unavailableCount,
  };
}

/**
 * Aggregate all recipient results into a notification-level result.
 *
 * The processor uses `shouldDispatch` to decide whether to mark the outbox event
 * DISPATCHED. The current policy is: dispatch only if at least one recipient was
 * successfully delivered to at least one channel.
 */
export function aggregateNotificationResult(
  recipients: RecipientDeliveryResult[],
): NotificationDeliveryResult {
  const successfulRecipients = recipients.filter((r) => r.succeeded).length;
  const skippedRecipients = recipients.filter(
    (r) =>
      !r.succeeded &&
      r.skippedCount > 0 &&
      r.retryableFailureCount === 0 &&
      r.terminalFailureCount === 0,
  ).length;
  const retryableRecipients = recipients.filter(
    (r) => !r.succeeded && r.retryableFailureCount > 0,
  ).length;
  const terminalRecipients = recipients.filter(
    (r) =>
      !r.succeeded &&
      r.terminalFailureCount > 0 &&
      r.retryableFailureCount === 0,
  ).length;

  const anySuccess = successfulRecipients > 0;
  const completeFailure = successfulRecipients === 0;

  // Dispatch policy: dispatch only if at least one recipient was successfully
  // delivered to at least one channel. Partial success is allowed and expected.
  const shouldDispatch = anySuccess;

  return {
    recipients,
    totalRecipients: recipients.length,
    successfulRecipients,
    skippedRecipients,
    retryableRecipients,
    terminalRecipients,
    anySuccess,
    completeFailure,
    shouldDispatch,
  };
}

/**
 * Helper to determine if a recipient should be retried.
 *
 * A recipient should be retried if it has at least one retryable failure and
 * was not successfully delivered to any channel.
 */
export function shouldRetryRecipient(result: RecipientDeliveryResult): boolean {
  return !result.succeeded && result.retryableFailureCount > 0;
}

/**
 * Extract the list of channels that should be retried for a recipient.
 */
export function getRetryableChannels(
  result: RecipientDeliveryResult,
): DeliveryChannel[] {
  return result.channels
    .filter((c) => c.outcome === DeliveryOutcome.RETRYABLE_FAILURE)
    .map((c) => c.channel);
}
