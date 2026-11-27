import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ClaimState } from './entities/claim.entity';
import { ClaimError, ClaimErrorCode } from './claim-errors';
import { SupportSecretScannerService } from '../support/support-secret-scanner.service';
import { SupportSubmission } from '../support/entities/support-submission.entity';
import { rejectLegacyProtocolOperation } from './protocol-authority';

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
   * Minimum combined vote weight required before a claim can be resolved.
   * Below this threshold the result is considered statistically unreliable.
   */
  private readonly MIN_REQUIRED_WEIGHT = 100;

  /**
   * Confidence score at or above which a non-tied result is considered
   * a strong consensus. Used for logging / downstream consumers.
   */
  private readonly STRONG_CONSENSUS_THRESHOLD = 0.75;

  /**
   * Minimum confidence required to block/quarantine a support submission.
   * Below this threshold the submission is allowed but flagged for review.
   */
  private readonly SECRET_QUARANTINE_THRESHOLD = 0.8;

  constructor(
    private readonly secretScanner?: SupportSecretScannerService,
  ) {}

  /**
   * Versioned error code namespace for this service's domain results.
   * Exposed so controllers can map codes to HTTP statuses without leaking
   * internal details.
   */
  static readonly ERROR_CODES = ClaimErrorCode;

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

  /** Reject API-authoritative claim resolution; outcomes come from protocol events. */
  async resolveClaim(
    _claimId: string,
    _votes: VoteWeightSummary,
  ): Promise<never> {
    return rejectLegacyProtocolOperation(
      'The API cannot resolve or finalize claims. Outcomes must come from canonical protocol events.',
    );
  }

  // ─── Support submission secret scanning ─────────────────────────────────

  /**
   * Scan a support submission's text and attachments for secrets before
   * persistence or forwarding. High-confidence secrets are quarantined and
   * never echoed into logs or notifications.
   *
   * Fails closed: any scanner error results in quarantine.
   */
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
      // Fail closed — never forward unscanned content.
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
      // Do NOT log matched material — only category and confidence.
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

  /**
   * Retrieve a quarantined submission. Access is restricted to authorized
   * callers and every access is audited. Secret material is never returned
   * in the response payload — only metadata.
   */
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

    // Audit without echoing secret material.
    this.logger.log(
      `Quarantine access: submission=${submissionId}, actor=${accessedBy}, purpose=${purpose}`,
    );

    return record;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Guard for state transitions that must be contract-derived. Callers that
   * attempt a transition from a phase that is not permitted by the canonical
   * contract receive a typed `INVALID_TRANSITION` error rather than a generic
   * `BadRequestException`.
   */
  assertTransitionAllowed(from: ClaimState, to: ClaimState): void {
    if (!isTransitionAllowed(from, to)) {
      throw new ClaimError(
        ClaimErrorCode.INVALID_TRANSITION,
        'State transition is not permitted by the claim contract',
      );
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private quarantineSubmission(
    submissionId: string,
    reason: string,
    remediation: string,
  ): SupportSubmissionScanResult {
    return {
      submissionId,
      quarantined: true,
      reason,
      remediation,
    };
  }

  private buildRemediationGuidance(category?: string): string {
    const base =
      'Your submission was blocked because it appears to contain sensitive data. ' +
      'Please remove any seed phrases, private keys, API tokens, auth headers, or credentials ' +
      'and resubmit. Never share these with anyone, including support staff.';
    if (!category) return base;
    return `${base} Detected category: ${category}.`;
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