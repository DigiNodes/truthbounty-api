import { BadRequestException } from '@nestjs/common';

export interface AdvisoryVoteWeightSummary {
  trueWeight: number;
  falseWeight: number;
}

export interface AdvisoryConfidence {
  readonly kind: 'advisory';
  score: number;
  suggestedVerdict: 'true' | 'false' | 'inconclusive';
  margin: number;
  participation: number;
  totalWeight: number;
}

const MIN_REQUIRED_WEIGHT = 100;

/**
 * Estimate confidence from off-chain vote weights. This result is advisory
 * only; it is not a protocol verdict and must never drive claim state.
 */
export function advisoryConfidence(
  votes: AdvisoryVoteWeightSummary,
): AdvisoryConfidence | null {
  if (
    !votes ||
    !Number.isFinite(votes.trueWeight) ||
    !Number.isFinite(votes.falseWeight) ||
    votes.trueWeight < 0 ||
    votes.falseWeight < 0
  ) {
    throw new BadRequestException('Vote weights must be finite and non-negative');
  }

  const totalWeight = votes.trueWeight + votes.falseWeight;
  if (totalWeight < MIN_REQUIRED_WEIGHT) return null;

  const margin = Math.abs(votes.trueWeight - votes.falseWeight) / totalWeight;
  const participation = Math.min(totalWeight / MIN_REQUIRED_WEIGHT, 1);
  const score = Number((margin * participation).toFixed(4));
  const suggestedVerdict =
    votes.trueWeight === votes.falseWeight
      ? 'inconclusive'
      : votes.trueWeight > votes.falseWeight
        ? 'true'
        : 'false';

  return {
    kind: 'advisory',
    score,
    suggestedVerdict,
    margin,
    participation,
    totalWeight,
  };
}
