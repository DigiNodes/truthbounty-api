export interface RecoveryObservation {
  completed: boolean;
  duplicateEffects: number;
  committedCheckpoint?: number;
  errorMessage?: string;
  retryCount?: number;
  finalizedFromUntrustedInput?: boolean;
}

export function assertBoundedFailure(
  observation: RecoveryObservation,
  maxRetries: number,
): void {
  if ((observation.retryCount ?? 0) > maxRetries) {
    throw new Error(`Retry budget exceeded: ${observation.retryCount}`);
  }

  if (observation.errorMessage?.match(/secret|token|password|private[_ -]?key/i)) {
    throw new Error('Sensitive material appeared in an error observation');
  }
}

export function assertIdempotentRecovery(
  observation: RecoveryObservation,
): void {
  if (observation.duplicateEffects !== 0) {
    throw new Error(
      `Recovery produced ${observation.duplicateEffects} duplicate effects`,
    );
  }
}

export function assertFailClosed(
  observation: RecoveryObservation,
): void {
  if (observation.finalizedFromUntrustedInput) {
    throw new Error('Untrusted chain input was treated as finalized');
  }
}
