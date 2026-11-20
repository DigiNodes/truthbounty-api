import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Claim, ClaimState } from './entities/claim.entity';
import { ClaimError, ClaimErrorCode } from './claim-errors';
import { SupportSecretScannerService } from '../support/support-secret-scanner.service';
import { SupportSubmission } from '../support/entities/support-submission.entity';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Off-chain vote weight summary.
 *
 * NON-AUTHORITATIVE. This shape describes observed off-chain signal only.
 * It must never be converted into a canonical verdict, finality flag, or
 * persisted into Claim.resolvedVerdict / Claim.finalized. Consuming it via
 * ClaimResolutionService.advisoryConfidence() is the only permitted use.
 */
export interface VoteWeightSummary {
  trueWeight: number;
  falseWeight: number;
}

export type AdvisoryVerdict = 'true' | 'false' | 'inconclusive';

/**
 * Advisory analytics output. Explicitly non-authoritative: it carries a
 * `readonly kind` discriminant and cannot be passed to any persistence path
 * in this service. Downstream consumers must treat it as display-only signal.
 */
export interface AdvisoryConfidence {
  readonly kind: 'advisory';
  readonly score: number;
  readonly verdict: AdvisoryVerdict;
  readonly margin: number;
  readonly participation: number;
  readonly totalWeight: number;
}

export interface SupportSubmissionScanResult {
  submissionId: string;
  quarantined: boolean;
  reason?: string;
  remediation?: string;
}

export interface QuarantineAccessRecord {
  submissionId: string;
  accessedBy: string;
  accessedAt: Date;
  purpose: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ClaimResolutionService {
  private readonly logger = new Logger(ClaimResolutionService.name);

  /**
   * Minimum combined vote weight required before advisory confidence is
   * reported at all. Purely a display threshold — has no protocol meaning.
   */
  private readonly MIN_REQUIRED_WEIGHT = 100;

  /**
   * Advisory "strong consensus" threshold. Logging only.
   */
  private readonly ADVISORY_STRONG_CONSENSUS_THRESHOLD = 0.75;

  /**
   * Minimum confidence required to block/quarantine a support submission.
   */
  private readonly SECRET_QUARANTINE_THRESHOLD = 0.8;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    private readonly secretScanner?: SupportSecretScannerService,
  ) {}

  static readonly ERROR_CODES = ClaimErrorCode;

  // ─── Advisory analytics (non-authoritative) ─────────────────────────────

  /**
   * Compute advisory confidence from off-chain vote weights.
   *
   * NON-AUTHORITATIVE. The returned object is tagged `kind: 'advisory'` and
   * must never be persisted into canonical claim state or used to trigger a
   * state transition. Canonical verdict/finality is derived exclusively by
   * ClaimProjectionService from finalized on-chain events.
   *
   * Returns `null` when total weight is below MIN_REQUIRED_WEIGHT.
   */
  advisoryConfidence(votes: VoteWeightSummary): AdvisoryConfidence | null {
    this.validateVotes(votes);

    const { trueWeight, falseWeight } = votes;
    const total = trueWeight + falseWeight;
    if (total < this.MIN_REQUIRED_WEIGHT) return null;

    const margin = Math.abs(trueWeight - falseWeight) / total;
    const participation = Math.min(total / this.MIN_REQUIRED_WEIGHT, 1);
    const score = Number((margin * participation).toFixed(4));

    const verdict: AdvisoryVerdict =
      trueWeight === falseWeight
        ? 'inconclusive'
        : trueWeight > falseWeight
          ? 'true'
          : 'false';

    if (score >= this.ADVISORY_STRONG_CONSENSUS_THRESHOLD) {
      this.logger.debug(
        `Advisory strong-consensus signal (non-authoritative): score=${score}`,
      );
    }

    return {
      kind: 'advisory',
      score,
      verdict,
      margin,
      participation,
      totalWeight: total,
    };
  }

  // ─── Read-only canonical state ──────────────────────────────────────────

  /**
   * Read canonical finality. This method only READS. It never transitions a
   * claim. Finality is written exclusively by ClaimProjectionService when a
   * matching approved, finalized canonical event has been projected.
   */
  async isFinalized(claimId: string): Promise<boolean> {
    const count = await this.claimRepo.count({
      where: { id: claimId, finalized: true },
    });
    return count > 0;
  }

  /**
   * Guard for state transitions that must be contract-derived. Kept for use
   * by ClaimProjectionService only. This service does not call it to write —
   * it exists so projector code has a single, typed chokepoint for
   * transition validation.
   */
  assertTransitionAllowed(from: ClaimState, to: ClaimState): void {
    if (!isTransitionAllowed(from, to)) {
      throw new ClaimError(
        ClaimErrorCode.INVALID_TRANSITION,
        'State transition is not permitted by the claim contract',
      );
    }
  }

  // ─── Support submission secret scanning (unchanged) ─────────────────────

  async scanSupportSubmission(
    submission: SupportSubmission,
  ): Promise<SupportSubmissionScanResult> {
    if (!submission || !submission.id) {
      throw new BadRequestException('Support submission is required');
    }

    let scan: Awaited<ReturnType<SupportSecretScannerService['scan']>>;
    try {
      scan = await this.secretScanner!.scan({
        text: submission.body ?? '',
        attachments: submission.attachments ?? [],
      });
    } catch {
      this.logger.warn(
        `Secret scan failed for submission ${submission.id}; quarantining (fail-closed)`,
      );
      return this.quarantineSubmission(
        submission.id,
        'scan_error',
        'We could not process your submission. Please resubmit without sensitive data.',
      );
    }

    if (scan.highestConfidence >= this.SECRET_QUARANTINE_THRESHOLD) {
      this.logger.warn(
        `Submission ${submission.id} quarantined: category=${scan.topCategory ?? 'unknown'}, ` +
          `confidence=${scan.highestConfidence.toFixed(2)}`,
      );
      return this.quarantineSubmission(
        submission.id,
        scan.topCategory ?? 'secret',
        this.buildRemediationGuidance(scan.topCategory),
      );
    }

    return { submissionId: submission.id, quarantined: false };
  }

  async accessQuarantinedSubmission(
    submissionId: string,
    accessedBy: string,
    purpose: string,
  ): Promise<QuarantineAccessRecord> {
    if (!accessedBy || !purpose) {
      throw new BadRequestException(
        'Quarantine access requires an identified actor and purpose',
      );
    }
    const record: QuarantineAccessRecord = {
      submissionId,
      accessedBy,
      accessedAt: new Date(),
      purpose,
    };
    this.logger.log(
      `Quarantine access: submission=${submissionId}, actor=${accessedBy}, purpose=${purpose}`,
    );
    return record;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private quarantineSubmission(
    submissionId: string,
    reason: string,
    remediation: string,
  ): SupportSubmissionScanResult {
    return { submissionId, quarantined: true, reason, remediation };
  }

  private buildRemediationGuidance(category?: string): string {
    const base =
      'Your submission was blocked because it appears to contain sensitive data. ' +
      'Please remove any seed phrases, private keys, API tokens, auth headers, or credentials ' +
      'and resubmit. Never share these with anyone, including support staff.';
    return category ? `${base} Detected category: ${category}.` : base;
  }

  private validateVotes(votes: VoteWeightSummary): void {
    if (!votes) {
      throw new ClaimError(
        ClaimErrorCode.INVALID_VOTES,
        'Vote weight summary is required',
      );
    }
    if (votes.trueWeight < 0 || votes.falseWeight < 0) {
      throw new ClaimError(
        ClaimErrorCode.INVALID_VOTES,
        'Vote weights must be non-negative',
      );
    }
    if (
      !Number.isFinite(votes.trueWeight) ||
      !Number.isFinite(votes.falseWeight)
    ) {
      throw new ClaimError(
        ClaimErrorCode.INVALID_VOTES,
        'Vote weights must be finite numbers',
      );
    }
  }
}
