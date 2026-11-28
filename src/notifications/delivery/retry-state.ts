import { DeliveryChannel } from '../interfaces/notification.types';
import {
  NotificationDeliveryResult,
  RecipientDeliveryResult,
  ChannelDeliveryOutcome,
  DeliveryOutcome,
  shouldRetryRecipient,
  getRetryableChannels,
} from './delivery-outcome';

/**
 * State for a single channel-recipient pair that needs retry.
 */
export interface RetryableDeliveryAttempt {
  recipientId: string;
  channel: DeliveryChannel;
  failureKind: string;
  errorMessage: string;
  attemptCount: number;
  lastAttemptAt: Date;
  idempotencyKey?: string;
}

/**
 * Complete retry state for a notification delivery job.
 * 
 * Tracks which specific channel-recipient pairs failed with retryable errors
 * and should be retried on the next attempt, while excluding successfully
 * delivered pairs from retry.
 */
export interface NotificationRetryState {
  /** Original outbox event ID */
  outboxEventId: string;

  /** Event type being delivered */
  eventType: string;

  /** Original job idempotency key */
  idempotencyKey: string;

  /** Current retry attempt number (0-based) */
  attemptNumber: number;

  /** Maximum retry attempts allowed */
  maxAttempts: number;

  /** All channel-recipient pairs that need retry */
  retryableAttempts: RetryableDeliveryAttempt[];

  /** Recipients that successfully received at least one channel delivery */
  successfulRecipientIds: string[];

  /** Recipients that failed terminally and should not be retried */
  terminalRecipientIds: string[];

  /** Recipients that were skipped (no enabled channels, preferences, etc.) */
  skippedRecipientIds: string[];

  /** When this retry state was created */
  createdAt: Date;

  /** Original payload for templating on retry */
  payload: Record<string, any>;
}

/**
 * Extract retry state from a delivery result.
 * 
 * This function identifies which channel-recipient pairs need retry and
 * constructs a state object that can be persisted in the outbox metadata
 * or job data for the next retry attempt.
 */
export function extractRetryState(
  outboxEventId: string,
  eventType: string,
  idempotencyKey: string,
  attemptNumber: number,
  maxAttempts: number,
  deliveryResult: NotificationDeliveryResult,
  payload: Record<string, any>,
): NotificationRetryState {
  const retryableAttempts: RetryableDeliveryAttempt[] = [];
  const successfulRecipientIds: string[] = [];
  const terminalRecipientIds: string[] = [];
  const skippedRecipientIds: string[] = [];

  for (const recipient of deliveryResult.recipients) {
    if (recipient.succeeded) {
      successfulRecipientIds.push(recipient.userId);
      continue;
    }

    if (shouldRetryRecipient(recipient)) {
      // Extract retryable channels for this recipient
      const retryableChannels = recipient.channels.filter(
        (c) => c.outcome === DeliveryOutcome.RETRYABLE_FAILURE,
      );

      for (const channelOutcome of retryableChannels) {
        retryableAttempts.push({
          recipientId: recipient.userId,
          channel: channelOutcome.channel,
          failureKind: channelOutcome.failureKind || 'UNKNOWN',
          errorMessage: channelOutcome.errorMessage || 'Unknown error',
          attemptCount: (channelOutcome.retryAttempt || 0) + 1,
          lastAttemptAt: channelOutcome.attemptedAt,
          idempotencyKey: channelOutcome.idempotencyKey,
        });
      }
    } else if (
      recipient.terminalFailureCount > 0 &&
      recipient.retryableFailureCount === 0
    ) {
      terminalRecipientIds.push(recipient.userId);
    } else if (
      recipient.skippedCount > 0 &&
      recipient.retryableFailureCount === 0 &&
      recipient.terminalFailureCount === 0
    ) {
      skippedRecipientIds.push(recipient.userId);
    }
  }

  return {
    outboxEventId,
    eventType,
    idempotencyKey,
    attemptNumber,
    maxAttempts,
    retryableAttempts,
    successfulRecipientIds,
    terminalRecipientIds,
    skippedRecipientIds,
    createdAt: new Date(),
    payload,
  };
}

/**
 * Check if retry state has any retryable attempts.
 */
export function hasRetryableAttempts(state: NotificationRetryState): boolean {
  return state.retryableAttempts.length > 0;
}

/**
 * Check if retry budget is exhausted.
 */
export function isRetryBudgetExhausted(state: NotificationRetryState): boolean {
  return state.attemptNumber >= state.maxAttempts;
}

/**
 * Get unique recipient IDs that need retry.
 */
export function getRetryRecipientIds(state: NotificationRetryState): string[] {
  const recipientIds = new Set(
    state.retryableAttempts.map((a) => a.recipientId),
  );
  return Array.from(recipientIds);
}

/**
 * Get retry attempts for a specific recipient.
 */
export function getRecipientRetryAttempts(
  state: NotificationRetryState,
  recipientId: string,
): RetryableDeliveryAttempt[] {
  return state.retryableAttempts.filter((a) => a.recipientId === recipientId);
}

/**
 * Filter out successfully delivered recipients from a retry state.
 * 
 * Used when merging retry results to prevent re-attempting deliveries that
 * succeeded in a previous retry.
 */
export function removeSuccessfulRecipients(
  state: NotificationRetryState,
  successfulRecipientIds: string[],
): NotificationRetryState {
  const successfulSet = new Set([
    ...state.successfulRecipientIds,
    ...successfulRecipientIds,
  ]);

  return {
    ...state,
    retryableAttempts: state.retryableAttempts.filter(
      (a) => !successfulSet.has(a.recipientId),
    ),
    successfulRecipientIds: Array.from(successfulSet),
  };
}

/**
 * Merge a new delivery result into existing retry state.
 * 
 * When a retry attempt completes, this function updates the retry state to:
 * 1. Remove channel-recipient pairs that succeeded
 * 2. Update attempt counts for pairs that still failed
 * 3. Move terminal failures out of the retry pool
 * 4. Increment the overall attempt number
 */
export function mergeRetryResult(
  previousState: NotificationRetryState,
  newDeliveryResult: NotificationDeliveryResult,
): NotificationRetryState {
  const newSuccessfulIds: string[] = [];
  const newTerminalIds: string[] = [];
  const updatedRetryableAttempts: RetryableDeliveryAttempt[] = [];

  // Build maps for quick lookup
  const previousAttemptsMap = new Map<string, RetryableDeliveryAttempt>();
  for (const attempt of previousState.retryableAttempts) {
    const key = `${attempt.recipientId}:${attempt.channel}`;
    previousAttemptsMap.set(key, attempt);
  }

  // Process new results
  for (const recipient of newDeliveryResult.recipients) {
    if (recipient.succeeded) {
      newSuccessfulIds.push(recipient.userId);
      continue;
    }

    // Check each channel outcome
    for (const channelOutcome of recipient.channels) {
      const key = `${recipient.userId}:${channelOutcome.channel}`;
      const previousAttempt = previousAttemptsMap.get(key);

      if (channelOutcome.outcome === DeliveryOutcome.DELIVERED) {
        // This channel-recipient pair succeeded, don't add to retry list
        if (!newSuccessfulIds.includes(recipient.userId)) {
          newSuccessfulIds.push(recipient.userId);
        }
      } else if (channelOutcome.outcome === DeliveryOutcome.RETRYABLE_FAILURE) {
        // Still retryable, update attempt count
        updatedRetryableAttempts.push({
          recipientId: recipient.userId,
          channel: channelOutcome.channel,
          failureKind: channelOutcome.failureKind || 'UNKNOWN',
          errorMessage: channelOutcome.errorMessage || 'Unknown error',
          attemptCount: (previousAttempt?.attemptCount || 0) + 1,
          lastAttemptAt: channelOutcome.attemptedAt,
          idempotencyKey: channelOutcome.idempotencyKey,
        });
      } else if (channelOutcome.outcome === DeliveryOutcome.TERMINAL_FAILURE) {
        // Terminal failure, remove from retry pool
        if (!newTerminalIds.includes(recipient.userId)) {
          newTerminalIds.push(recipient.userId);
        }
      }
      // SKIPPED and CHANNEL_UNAVAILABLE don't go into retry
    }
  }

  // Remove successful and terminal recipients from retry attempts
  const excludedRecipients = new Set([...newSuccessfulIds, ...newTerminalIds]);
  const finalRetryableAttempts = updatedRetryableAttempts.filter(
    (a) => !excludedRecipients.has(a.recipientId),
  );

  return {
    ...previousState,
    attemptNumber: previousState.attemptNumber + 1,
    retryableAttempts: finalRetryableAttempts,
    successfulRecipientIds: [
      ...previousState.successfulRecipientIds,
      ...newSuccessfulIds,
    ],
    terminalRecipientIds: [
      ...previousState.terminalRecipientIds,
      ...newTerminalIds,
    ],
  };
}

/**
 * Create a summary string for logging and monitoring.
 */
export function summarizeRetryState(state: NotificationRetryState): string {
  const parts = [
    `attempt ${state.attemptNumber + 1}/${state.maxAttempts}`,
    `${state.retryableAttempts.length} retryable`,
    `${state.successfulRecipientIds.length} succeeded`,
    `${state.terminalRecipientIds.length} terminal`,
  ];

  if (state.skippedRecipientIds.length > 0) {
    parts.push(`${state.skippedRecipientIds.length} skipped`);
  }

  return parts.join(', ');
}

/**
 * Serialize retry state for storage in outbox metadata or job data.
 */
export function serializeRetryState(
  state: NotificationRetryState,
): Record<string, any> {
  return {
    outboxEventId: state.outboxEventId,
    eventType: state.eventType,
    idempotencyKey: state.idempotencyKey,
    attemptNumber: state.attemptNumber,
    maxAttempts: state.maxAttempts,
    retryableAttempts: state.retryableAttempts.map((a) => ({
      recipientId: a.recipientId,
      channel: a.channel,
      failureKind: a.failureKind,
      errorMessage: a.errorMessage,
      attemptCount: a.attemptCount,
      lastAttemptAt: a.lastAttemptAt.toISOString(),
      idempotencyKey: a.idempotencyKey,
    })),
    successfulRecipientIds: state.successfulRecipientIds,
    terminalRecipientIds: state.terminalRecipientIds,
    skippedRecipientIds: state.skippedRecipientIds,
    createdAt: state.createdAt.toISOString(),
    payload: state.payload,
  };
}

/**
 * Deserialize retry state from stored metadata or job data.
 */
export function deserializeRetryState(
  data: Record<string, any>,
): NotificationRetryState {
  return {
    outboxEventId: data.outboxEventId,
    eventType: data.eventType,
    idempotencyKey: data.idempotencyKey,
    attemptNumber: data.attemptNumber,
    maxAttempts: data.maxAttempts,
    retryableAttempts: (data.retryableAttempts || []).map((a: any) => ({
      recipientId: a.recipientId,
      channel: a.channel,
      failureKind: a.failureKind,
      errorMessage: a.errorMessage,
      attemptCount: a.attemptCount,
      lastAttemptAt: new Date(a.lastAttemptAt),
      idempotencyKey: a.idempotencyKey,
    })),
    successfulRecipientIds: data.successfulRecipientIds || [],
    terminalRecipientIds: data.terminalRecipientIds || [],
    skippedRecipientIds: data.skippedRecipientIds || [],
    createdAt: new Date(data.createdAt),
    payload: data.payload || {},
  };
}
