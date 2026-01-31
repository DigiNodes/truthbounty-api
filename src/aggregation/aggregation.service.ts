import { Injectable } from '@nestjs/common';
import {
  Verification,
  VerificationVerdict,
  ClaimStatus,
  AggregationResult,
} from './aggregation.types';

@Injectable()
export class AggregationService {
  /**
   * Aggregate verifications for a single claim.
   * Pure & deterministic.
   */
  aggregate(
    claimId: string,
    verifications: Verification[],
  ): AggregationResult {
    if (verifications.length === 0) {
      return {
        claimId,
        status: ClaimStatus.INCONCLUSIVE,
        confidence: 0,
        metadata: {
          trueWeight: 0,
          falseWeight: 0,
          verificationCount: 0,
        },
      };
    }

    let trueWeight = 0;
    let falseWeight = 0;

    for (const v of verifications) {
      const weight = this.computeWeight(v);

      if (v.verdict === VerificationVerdict.TRUE) {
        trueWeight += weight;
      } else {
        falseWeight += weight;
      }
    }

    const totalWeight = trueWeight + falseWeight;

    if (totalWeight === 0) {
      return this.inconclusiveResult(claimId, trueWeight, falseWeight, verifications.length);
    }

    // Tie handling
    if (trueWeight === falseWeight) {
      return this.inconclusiveResult(claimId, trueWeight, falseWeight, verifications.length);
    }

    const status =
      trueWeight > falseWeight
        ? ClaimStatus.VERIFIED_TRUE
        : ClaimStatus.VERIFIED_FALSE;

    const confidence = this.computeConfidence(
      Math.max(trueWeight, falseWeight),
      totalWeight,
    );

    // Extremely low confidence safeguard
    if (confidence < 10) {
      return this.inconclusiveResult(claimId, trueWeight, falseWeight, verifications.length);
    }

    return {
      claimId,
      status,
      confidence,
      metadata: {
        trueWeight,
        falseWeight,
        verificationCount: verifications.length,
      },
    };
  }

  /**
   * Weight formula (v1):
   * weight = stakeAmount * reputationWeight
   * No randomness, no time dependency.
   */
  private computeWeight(v: Verification): number {
    return v.stakeAmount * v.reputationWeight;
  }

  /**
   * Confidence formula (v1):
   * (winningWeight / totalWeight) * 100
   */
  private computeConfidence(
    winningWeight: number,
    totalWeight: number,
  ): number {
    return Math.round((winningWeight / totalWeight) * 100);
  }

  private inconclusiveResult(
    claimId: string,
    trueWeight: number,
    falseWeight: number,
    count: number,
  ): AggregationResult {
    return {
      claimId,
      status: ClaimStatus.INCONCLUSIVE,
      confidence: 0,
      metadata: {
        trueWeight,
        falseWeight,
        verificationCount: count,
      },
    };
  }
}
