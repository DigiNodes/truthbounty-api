import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThan,
  Repository,
} from 'typeorm';
import { ProjectDispute } from '../entities/project-dispute.entity';
import {
  ProjectVerificationRound,
  RoundType,
} from '../../verification/entities/project-verification-round.entity';
import { DataState } from '../../common/data-state.enum';
import { FinalityPolicyService } from '../../../config/finality-policy.service';
import {
  DISPUTE_DETAIL_READ_MODEL,
  DISPUTE_REGISTER_READ_MODEL,
  DISPUTE_READ_MODEL_DEFAULT_LIMIT,
  DISPUTE_READ_MODEL_MAX_LIMIT,
  DISPUTE_READ_MODEL_ORDER,
  DISPUTE_READ_MODEL_VERSION,
  DisputeReadModelDetailResponse,
  DisputeReadModelErrorBody,
  DisputeReadModelItem,
  DisputeReadModelListResponse,
  DisputeSettlement,
  ReadModelFreshness,
  ReleaseProvenance,
} from './dispute-read-model.types';
import {
  DisputeListCursor,
  decodeDisputeListCursor,
  encodeDisputeListCursor,
} from './dispute-read-model.cursor';
import { DisputeReadModelProvenanceService } from './dispute-read-model-provenance.service';
import { DisputeReadModelFreshnessService } from './dispute-read-model-freshness.service';
import { toDisputeReadModelItem } from './dispute-read-model-view';
import { DisputeListQuery } from './dto/dispute-read-model-query.dto';

/**
 * PREWAVE-BE-007 — publishes the versioned dispute register and dispute detail read
 * models.
 *
 * Authoritative inputs are chain-derived only: the canonical dispute lifecycle
 * projection (`v2_project_dispute`), the verification rounds, and the
 * finality checkpoints. The service never mutates protocol state and never
 * invents fields.
 *
 * Fail-closed gates (each throws a stable, machine-readable envelope):
 *  - missing/invalid release provenance        -> 503 STALE_RECONCILIATION
 *  - requested chain/release != served release  -> 400 UNSUPPORTED_CHAIN /
 *                                                  INVALID_ARTIFACT_VERSION
 *  - missing finality / stale / reorg detected  -> 503 STALE_RECONCILIATION
 *  - dispute not projected                     -> 404 NOT_FOUND
 *  - cursor/filter mismatch between pages       -> 400 (Bad Request)
 */
@Injectable()
export class DisputeReadModelService {
  private readonly logger = new Logger(DisputeReadModelService.name);

  constructor(
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    private readonly provenanceService: DisputeReadModelProvenanceService,
    private readonly freshnessService: DisputeReadModelFreshnessService,
    private readonly finalityPolicy: FinalityPolicyService,
  ) {}

  async getList(query: DisputeListQuery): Promise<DisputeReadModelListResponse> {
    const provenance = this.provenanceService.resolve();
    this.assertRequestedRelease(query, provenance);

    const freshness = await this.freshnessService.snapshot(provenance.chainId);
    this.assertFresh(freshness, provenance);

    const limit = this.clampLimit(query.limit);
    const cursor = this.resolveCursor(query, provenance);
    const snapshotAt = cursor?.snapshotAt ?? new Date().toISOString();

    const where: FindOptionsWhere<ProjectDispute> = {
      createdAt: LessThanOrEqual(new Date(snapshotAt)),
    };
    if (query.status) {
      where.status = query.status as ProjectDispute['status'];
    }
    if (cursor) {
      where.disputeId = MoreThan(cursor.disputeId);
    }

    const rows = await this.disputeRepo.find({
      where,
      order: { disputeId: 'ASC' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = await this.hydrate(page, provenance, freshness);

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeDisputeListCursor({
            v: 1,
            disputeId: lastRow.disputeId,
            snapshotAt,
            order: DISPUTE_READ_MODEL_ORDER,
            chainId: provenance.chainId,
            status: query.status ?? null,
          })
        : null;

    return {
      readModel: DISPUTE_REGISTER_READ_MODEL,
      readModelVersion: DISPUTE_READ_MODEL_VERSION,
      observedAt: new Date().toISOString(),
      provenance,
      freshness,
      pagination: {
        nextCursor,
        hasMore,
        limit,
        order: DISPUTE_READ_MODEL_ORDER,
        snapshotAt,
      },
      data,
    };
  }

  async getDetail(disputeId: string): Promise<DisputeReadModelDetailResponse> {
    const provenance = this.provenanceService.resolve();
    const freshness = await this.freshnessService.snapshot(provenance.chainId);
    this.assertFresh(freshness, provenance);

    const row = await this.disputeRepo.findOne({
      where: { disputeId },
    });

    if (!row) {
      throw this.failClosed(
        'NOT_FOUND',
        HttpStatus.NOT_FOUND,
        `No canonical dispute read model is published for dispute ${disputeId}`,
        'dispute_not_projected',
        provenance,
      );
    }

    const [item] = await this.hydrate([row], provenance, freshness);

    return {
      readModel: DISPUTE_DETAIL_READ_MODEL,
      readModelVersion: DISPUTE_READ_MODEL_VERSION,
      observedAt: new Date().toISOString(),
      provenance,
      freshness,
      data: item,
    };
  }

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  private assertRequestedRelease(
    query: DisputeListQuery,
    provenance: ReleaseProvenance,
  ): void {
    if (query.chainId !== undefined && query.chainId !== provenance.chainId) {
      throw this.failClosed(
        'UNSUPPORTED_CHAIN',
        HttpStatus.BAD_REQUEST,
        'Requested chain is not the release the dispute read models are bound to',
        'chain_release_mismatch',
        provenance,
        { chainId: provenance.chainId },
        { chainId: query.chainId },
      );
    }
    if (
      query.releaseId !== undefined &&
      query.releaseId !== provenance.releaseId
    ) {
      throw this.failClosed(
        'INVALID_ARTIFACT_VERSION',
        HttpStatus.BAD_REQUEST,
        'Requested release is not the release the dispute read models are bound to',
        'wrong_release',
        provenance,
        { releaseId: provenance.releaseId },
        { releaseId: query.releaseId },
      );
    }
  }

  private assertFresh(
    freshness: ReadModelFreshness,
    provenance: ReleaseProvenance,
  ): void {
    if (!freshness.stale) return;
    this.logger.warn(
      `Dispute read models fail closed (release=${provenance.releaseId}): ${freshness.staleReasons.join(', ')}`,
    );
    throw this.failClosed(
      'STALE_RECONCILIATION',
      HttpStatus.SERVICE_UNAVAILABLE,
      'Dispute read models are not fresh enough to serve; failing closed',
      freshness.staleReasons.join(', '),
      provenance,
    );
  }

  private resolveCursor(
    query: DisputeListQuery,
    provenance: ReleaseProvenance,
  ): DisputeListCursor | null {
    if (!query.cursor) return null;
    const cursor = decodeDisputeListCursor(query.cursor);

    if (cursor.chainId !== provenance.chainId) {
      throw this.failClosed(
        'INVALID_ARTIFACT_VERSION',
        HttpStatus.BAD_REQUEST,
        'Cursor belongs to a different release than the one being served',
        'cursor_release_mismatch',
        provenance,
        { chainId: provenance.chainId },
        { chainId: cursor.chainId },
      );
    }
    if (cursor.status !== (query.status ?? null)) {
      throw new HttpException(
        'Cursor filter mismatch: status must match the cursor',
        HttpStatus.BAD_REQUEST,
      );
    }
    return cursor;
  }

  private clampLimit(limit: number | undefined): number {
    if (!limit || !Number.isFinite(limit) || limit <= 0) {
      return DISPUTE_READ_MODEL_DEFAULT_LIMIT;
    }
    return Math.min(Math.trunc(limit), DISPUTE_READ_MODEL_MAX_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Hydration (batched, no per-row N+1)
  // -------------------------------------------------------------------------

  private async hydrate(
    rows: ProjectDispute[],
    provenance: ReleaseProvenance,
    freshness: ReadModelFreshness,
  ): Promise<DisputeReadModelItem[]> {
    if (rows.length === 0) return [];

    const claimIds = rows.map((row) => row.claimId);
    const appealRoundIds = rows
      .map((row) => row.appealRoundId)
      .filter((roundId): roundId is string => Boolean(roundId));
    const checkpoint = {
      lastSafeBlock: freshness.safeBlock ?? '0',
      lastFinalizedBlock: freshness.finalizedBlock ?? '0',
    };

    // An appeal deadline belongs to the exact appeal round linked by the
    // canonical DisputeRaised projection. Never select the latest round for
    // the claim: it may be a first round or an unrelated later appeal.
    const appealRounds =
      appealRoundIds.length > 0
        ? await this.roundRepo.find({
            where: {
              claimId: In(claimIds),
              roundId: In(appealRoundIds),
              roundType: RoundType.APPEAL,
            },
          })
        : [];
    // Round IDs are scoped to a claim. Keep the composite identity and
    // reject duplicate canonical rows instead of silently selecting one.
    const appealRoundsByKey = new Map<string, ProjectVerificationRound[]>();
    for (const round of appealRounds) {
      const key = `${round.claimId}:${round.roundId}`;
      const matches = appealRoundsByKey.get(key) ?? [];
      matches.push(round);
      appealRoundsByKey.set(key, matches);
    }

    return rows.map((row) => {
      const linkedRounds = row.appealRoundId
        ? appealRoundsByKey.get(`${row.claimId}:${row.appealRoundId}`) ?? []
        : [];
      const appealRound = linkedRounds.length === 1 ? linkedRounds[0] : undefined;

      if (row.appealRoundId && linkedRounds.length !== 1) {
        throw this.failClosed(
          'STALE_RECONCILIATION',
          HttpStatus.SERVICE_UNAVAILABLE,
          'The referenced appeal round is not available in the canonical projection',
          'appeal_round_missing_or_ambiguous',
          provenance,
          { disputeId: row.disputeId, appealRoundId: row.appealRoundId },
        );
      }

      if (appealRound) {
        if (appealRound.claimId !== row.claimId) {
          throw this.failClosed(
            'STALE_RECONCILIATION',
            HttpStatus.SERVICE_UNAVAILABLE,
            'The referenced appeal round belongs to a different claim',
            'appeal_round_claim_mismatch',
            provenance,
            { claimId: row.claimId },
            { claimId: appealRound.claimId },
          );
        }

        const appealRoundState = this.finalityPolicy.classifyByCheckpoint(
          appealRound.openedAtBlock,
          checkpoint,
        );
        if (appealRoundState !== DataState.FINALIZED || !appealRound.appealDeadline) {
          throw this.failClosed(
            'STALE_RECONCILIATION',
            HttpStatus.SERVICE_UNAVAILABLE,
            'The referenced appeal round deadline is not finalized and complete',
            'appeal_round_not_finalized_or_deadline_missing',
            provenance,
            { disputeId: row.disputeId, appealRoundId: row.appealRoundId },
            {
              dataState: appealRoundState,
              hasAppealDeadline: Boolean(appealRound.appealDeadline),
            },
          );
        }
      }

      const dataState = this.finalityPolicy.classifyByCheckpoint(
        row.blockNumber,
        checkpoint,
      );
      // Settlement and bond disposition remain explicitly unknown until a
      // finalized, dispute-bound source with event provenance is available.
      const settlement: DisputeSettlement = {
        pending: null,
        state: null,
        rewardAmount: null,
        refundAmount: null,
        slashedAmount: null,
      };

      return toDisputeReadModelItem(row, {
        provenance,
        dataState,
        appealDeadline: appealRound?.appealDeadline ?? null,
        provisionalOutcome: null,
        terminalBondDisposition: row.status === 'resolved' ? 'unknown' : null,
        settlement,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private failClosed(
    code: DisputeReadModelErrorBody['code'],
    status: number,
    message: string,
    reason: string,
    provenance: ReleaseProvenance | null,
    expected?: Record<string, unknown>,
    received?: Record<string, unknown>,
  ): HttpException {
    if (code !== 'NOT_FOUND') {
      this.logger.warn(`Dispute read models fail closed: ${code}/${reason}`);
    }
    const body: DisputeReadModelErrorBody = {
      code,
      message,
      failClosed: true,
      reason,
      provenance,
      ...(expected ? { expected } : {}),
      ...(received ? { received } : {}),
    };
    return new HttpException(body, status);
  }

}
