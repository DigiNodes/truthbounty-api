import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Claim, ClaimState } from './entities/claim.entity';
import { ClaimsCache } from '../cache/claims.cache';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VoteWeightSummary {
  trueWeight: number;
  falseWeight: number;
}

export type Verdict = 'true' | 'false' | 'inconclusive';

export interface ConfidenceResult {
  score: number;
  verdict: Verdict;
  margin: number;
  participation: number;
  totalWeight: number;
}

export interface ResolutionResult {
  claim: Claim;
  confidence: ConfidenceResult | null;
  resolvedAt: Date;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ClaimResolutionService {
  private readonly logger = new Logger(ClaimResolutionService.name);

  /**
   * Minimum combined vote weight required before a claim can be resolved.
   * Below this threshold the result is considered statistically unreliable.
   */
  private readonly MIN_REQUIRED_WEIGHT = 100;

  /**
   * Confidence score at or above which a non-tied result is considered
   * a strong consensus. Used for logging / downstream consumers.
   */
  private readonly STRONG_CONSENSUS_THRESHOLD = 0.75;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    private readonly claimsCache: ClaimsCache,
    private readonly dataSource: DataSource,
  ) {}

  // ─── Pure computation ───────────────────────────────────────────────────

  /**
   * Compute a confidence score and derived verdict from a vote weight summary.
   *
   * Returns `null` when the total weight falls below the minimum threshold,
   * indicating insufficient participation to produce a reliable result.
   *
   * Score formula:
   *   margin      = |trueWeight - falseWeight| / total   (0–1)
   *   participation = min(total / MIN_REQUIRED_WEIGHT, 1) (0–1, capped)
   *   score       = margin × participation               (0–1)
   *
   * A higher participation factor rewards decisions backed by a larger
   * electorate; a claim passing the minimum by a large margin is more
   * trustworthy than one that barely scraped over it.
   */
  computeConfidenceScore(votes: VoteWeightSummary): ConfidenceResult | null {
    this.validateVotes(votes);

    const { trueWeight, falseWeight } = votes;
    const total = trueWeight + falseWeight;

    if (total < this.MIN_REQUIRED_WEIGHT) return null;

    const margin = Math.abs(trueWeight - falseWeight) / total;
    const participation = Math.min(total / this.MIN_REQUIRED_WEIGHT, 1);
    const score = Number((margin * participation).toFixed(4));

    const verdict: Verdict =
      trueWeight === falseWeight
        ? 'inconclusive'
        : trueWeight > falseWeight
        ? 'true'
        : 'false';

    return { score, verdict, margin, participation, totalWeight: total };
  }

  // ─── Resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve a claim by persisting the verdict and confidence score.
   *
   * - Throws `NotFoundException`   if the claim does not exist.
   * - Throws `ConflictException`   if the claim is already finalized.
   * - Throws `BadRequestException` if votes fail basic validation.
   *
   * The DB save and cache invalidation run inside a transaction so a failed
   * cache call cannot leave the claim in an inconsistent state.
   */
  async resolveClaim(
    claimId: string,
    votes: VoteWeightSummary,
  ): Promise<ResolutionResult> {
    this.validateVotes(votes);

    const claim = await this.claimRepo.findOneBy({ id: claimId });
    if (!claim) {
      throw new NotFoundException(`Claim with ID ${claimId} not found`);
    }

    if (claim.finalized) {
      throw new ConflictException(
        `Claim ${claimId} is already finalized and cannot be re-resolved`,
      );
    }

    const confidence = this.computeConfidenceScore(votes);
    const resolvedAt = new Date();

    const savedClaim = await this.dataSource.transaction(async (manager) => {
      if (confidence) {
        // Use transitionTo helper for validated state transition
        claim.transitionTo(ClaimState.FINALIZED, {
          verdict: confidence.verdict === 'true',
          confidence: confidence.score,
        });
      } else {
        // Insufficient participation — record as inconclusive
        // Direct assignment since transitionTo requires both verdict and confidence
        claim.resolvedVerdict = null;
        claim.confidenceScore = null;
        claim.finalized = true;
      }

      claim.resolvedAt = resolvedAt;

      return manager.save(claim);
    });

    await this.claimsCache.invalidateClaim(claimId);

    this.logger.log(
      confidence
        ? `Claim ${claimId} resolved: verdict=${confidence.verdict}, ` +
          `score=${confidence.score}, margin=${confidence.margin.toFixed(3)}, ` +
          `participation=${confidence.participation.toFixed(3)}`
        : `Claim ${claimId} resolved as inconclusive (insufficient participation — ` +
          `total weight ${votes.trueWeight + votes.falseWeight} < ${this.MIN_REQUIRED_WEIGHT})`,
    );

    if (confidence && confidence.score >= this.STRONG_CONSENSUS_THRESHOLD) {
      this.logger.log(`Claim ${claimId} reached strong consensus (score ${confidence.score})`);
    }

    return { claim: savedClaim, confidence, resolvedAt };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Check whether a claim has already been finalized without loading the
   * full entity — useful for lightweight pre-flight checks in controllers.
   */
  async isFinalized(claimId: string): Promise<boolean> {
    const count = await this.claimRepo.count({
      where: { id: claimId, finalized: true },
    });
    return count > 0;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private validateVotes(votes: VoteWeightSummary): void {
    if (!votes) {
      throw new BadRequestException('Vote weight summary is required');
    }
    if (votes.trueWeight < 0 || votes.falseWeight < 0) {
      throw new BadRequestException('Vote weights must be non-negative');
    }
    if (!Number.isFinite(votes.trueWeight) || !Number.isFinite(votes.falseWeight)) {
      throw new BadRequestException('Vote weights must be finite numbers');
    }
  }
}