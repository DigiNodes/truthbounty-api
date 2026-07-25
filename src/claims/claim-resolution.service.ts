import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { ClaimsCache } from '../cache/claims.cache';
import {
  assertResolvedAtInvariant,
  buildResolvedFields,
} from './claim-resolution.invariant';

interface VoteWeightSummary {
  trueWeight: number;
  falseWeight: number;
}

@Injectable()
export class ClaimResolutionService {
  private readonly MIN_REQUIRED_WEIGHT = 100;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    private readonly claimsCache: ClaimsCache,
  ) { }

  computeConfidenceScore(votes: VoteWeightSummary): number | null {
    const { trueWeight, falseWeight } = votes;
    const total = trueWeight + falseWeight;

    // Safety rules
    if (total < this.MIN_REQUIRED_WEIGHT) return null;
    if (trueWeight === falseWeight) return 0;

    const margin = Math.abs(trueWeight - falseWeight) / total;
    const participation = Math.min(
      total / this.MIN_REQUIRED_WEIGHT,
      1,
    );

    return Number((margin * participation).toFixed(4));
  }

  async resolveClaim(
    claimId: string,
    votes: VoteWeightSummary,
  ) {
    const claim = await this.claimRepo.findOneBy({ id: claimId });
    if (!claim) throw new Error('Claim not found');

    const verdict = votes.trueWeight > votes.falseWeight;
    const confidence = this.computeConfidenceScore(votes);

    // Set resolvedVerdict and resolvedAt atomically — invariant BE-219
    const { resolvedVerdict, resolvedAt } = buildResolvedFields(verdict);
    claim.resolvedVerdict = resolvedVerdict;
    claim.resolvedAt = resolvedAt;
    claim.confidenceScore = confidence;
    claim.finalized = true;

    // Guard against any inconsistent state before persisting
    assertResolvedAtInvariant(claim);

    const savedClaim = await this.claimRepo.save(claim);
    // Invalidate both the claim-specific cache and the latest claims list cache
    await this.claimsCache.invalidateClaim(claimId);
    return savedClaim;
  }
}
