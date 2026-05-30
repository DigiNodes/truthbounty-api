import {
  MIN_AGGREGATION_CONFIDENCE,
} from '../constants/protocol';

export function applyConfidenceFloor(
  confidence: number,
): number {
  if (
    Number.isNaN(confidence)
  ) {
    return (
      MIN_AGGREGATION_CONFIDENCE
    );
  }

  return Math.max(
    confidence,
    MIN_AGGREGATION_CONFIDENCE,
  );
}

export function normalizeConfidence(
  confidence: number,
): number {
  if (
    !Number.isFinite(confidence)
  ) {
    return 0.5;
  }

  return Math.min(
    1,
    Math.max(confidence, 0.5),
  );
}