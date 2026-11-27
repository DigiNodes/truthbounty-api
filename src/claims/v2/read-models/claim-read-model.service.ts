import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThan,
  Repository,
} from 'typeorm';
import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import { ClaimState } from '../../../domain/claim/claimState';
import { ArtifactRegistryService } from '../../../v2/events/artifact-registry.service';
import { CanonicalEvent } from '../../../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../../../v2/events/entities/event-checkpoint.entity';
import { DataState } from '../../../v2/common/data-state.enum';
import {
  EvidenceStatus,
  ProjectEvidence,
} from '../../../v2/evidence/entities/project-evidence.entity';
import { ProjectVerificationRound } from '../../../v2/verification/entities/project-verification-round.entity';
import { FinalityPolicyService } from '../../../config/finality-policy.service';
import {
  CLAIM_DETAIL_READ_MODEL,
  CLAIM_LIST_READ_MODEL,
  CLAIM_READ_MODEL_DEFAULT_LIMIT,
  CLAIM_READ_MODEL_MAX_LIMIT,
  CLAIM_READ_MODEL_ORDER,
  CLAIM_READ_MODEL_VERSION,
  ClaimDeadlines,
  ClaimReadModelDetailResponse,
  ClaimReadModelErrorBody,
  ClaimReadModelItem,
  ClaimReadModelListResponse,
  EvidenceAvailability,
  ReadModelFreshness,
  ReleaseProvenance,
} from './claim-read-model.types';
import {
  ClaimListCursor,
  decodeClaimListCursor,
  encodeClaimListCursor,
} from './claim-read-model.cursor';
import { ClaimReadModelProvenanceService } from './claim-read-model-provenance.service';
import { ClaimReadModelFreshnessService } from './claim-read-model-freshness.service';
import { toClaimReadModelItem } from './claim-read-model-view';
import { ClaimListQuery } from './dto/claim-list-query.dto';

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * PREWAVE-BE-005 — publishes the versioned claim list and claim detail read
 * models.
 *
 * Authoritative inputs are chain-derived only: the canonical claim lifecycle
 * projection (`claim_read_models`), the evidence/verification projections, and
 * the finality checkpoints. The service never mutates protocol state and never
 * invents fields.
 *
 * Fail-closed gates (each throws a stable, machine-readable envelope):
 *  - missing/invalid release provenance        -> 503 STALE_RECONCILIATION
 *  - requested chain/release != served release  -> 400 UNSUPPORTED_CHAIN /
 *                                                  INVALID_ARTIFACT_VERSION
 *  - missing finality / stale / reorg detected  -> 503 STALE_RECONCILIATION
 *  - claim not projected                        -> 404 NOT_FOUND
 *  - cursor/filter mismatch between pages       -> 400 (Bad Request)
 */
@Injectable()
export class ClaimReadModelService {
  private readonly logger = new Logger(ClaimReadModelService.name);

  constructor(
    @InjectRepository(ClaimReadModel)
    private readonly readModelRepo: Repository<ClaimReadModel>,
    @InjectRepository(CanonicalEvent)
    private readonly canonicalEventRepo: Repository<CanonicalEvent>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    @InjectRepository(ProjectEvidence)
    private readonly evidenceRepo: Repository<ProjectEvidence>,
    @InjectRepository(ProjectVerificationRound)
    private readonly roundRepo: Repository<ProjectVerificationRound>,
    private readonly artifactRegistry: ArtifactRegistryService,
    private readonly provenanceService: ClaimReadModelProvenanceService,
    private readonly freshnessService: ClaimReadModelFreshnessService,
    private readonly finalityPolicy: FinalityPolicyService,
  ) {}

  async getList(query: ClaimListQuery): Promise<ClaimReadModelListResponse> {
    const provenance = this.provenanceService.resolve();
    this.assertRequestedRelease(query, provenance);

    const freshness = await this.freshnessService.snapshot(provenance.chainId);
    this.assertFresh(freshness, provenance);

    const limit = this.clampLimit(query.limit);
    const cursor = this.resolveCursor(query, provenance);
    const snapshotAt = cursor?.snapshotAt ?? new Date().toISOString();

    const where: FindOptionsWhere<ClaimReadModel> = {
      chainId: String(provenance.chainId),
      createdAt: LessThanOrEqual(new Date(snapshotAt)),
    };
    if (query.state) {
      where.state = query.state as ClaimReadModel['state'];
    }
    if (cursor) {
      where.claimId = MoreThan(cursor.claimId);
    }

    const rows = await this.readModelRepo.find({
      where,
      order: { claimId: 'ASC' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = await this.hydrate(page, provenance, freshness);

    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeClaimListCursor({
            v: 1,
            claimId: lastRow.claimId,
            snapshotAt,
            order: CLAIM_READ_MODEL_ORDER,
            chainId: provenance.chainId,
            state: query.state ?? null,
          })
        : null;

    return {
      readModel: CLAIM_LIST_READ_MODEL,
      readModelVersion: CLAIM_READ_MODEL_VERSION,
      observedAt: new Date().toISOString(),
      provenance,
      freshness,
      pagination: {
        nextCursor,
        hasMore,
        limit,
        order: CLAIM_READ_MODEL_ORDER,
        snapshotAt,
      },
      data,
    };
  }

  async getDetail(claimId: string): Promise<ClaimReadModelDetailResponse> {
    const provenance = this.provenanceService.resolve();
    const freshness = await this.freshnessService.snapshot(provenance.chainId);
    this.assertFresh(freshness, provenance);

    const row = await this.readModelRepo.findOne({
      where: { claimId, chainId: String(provenance.chainId) },
    });

    if (!row) {
      throw this.failClosed(
        'NOT_FOUND',
        HttpStatus.NOT_FOUND,
        `No canonical claim read model is published for claim ${claimId}`,
        'claim_not_projected',
        provenance,
      );
    }

    const [item] = await this.hydrate([row], provenance, freshness);

    return {
      readModel: CLAIM_DETAIL_READ_MODEL,
      readModelVersion: CLAIM_READ_MODEL_VERSION,
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
    query: ClaimListQuery,
    provenance: ReleaseProvenance,
  ): void {
    if (query.chainId !== undefined && query.chainId !== provenance.chainId) {
      throw this.failClosed(
        'UNSUPPORTED_CHAIN',
        HttpStatus.BAD_REQUEST,
        'Requested chain is not the release the claim read models are bound to',
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
        'Requested release is not the release the claim read models are bound to',
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
      `Claim read models fail closed (release=${provenance.releaseId}): ${freshness.staleReasons.join(', ')}`,
    );
    throw this.failClosed(
      'STALE_RECONCILIATION',
      HttpStatus.SERVICE_UNAVAILABLE,
      'Claim read models are not fresh enough to serve; failing closed',
      freshness.staleReasons.join(', '),
      provenance,
    );
  }

  private resolveCursor(
    query: ClaimListQuery,
    provenance: ReleaseProvenance,
  ): ClaimListCursor | null {
    if (!query.cursor) return null;
    const cursor = decodeClaimListCursor(query.cursor);

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
    if (cursor.state !== (query.state ?? null)) {
      throw new HttpException(
        'Cursor filter mismatch: state must match the cursor',
        HttpStatus.BAD_REQUEST,
      );
    }
    return cursor;
  }

  private clampLimit(limit: number | undefined): number {
    if (!limit || !Number.isFinite(limit) || limit <= 0) {
      return CLAIM_READ_MODEL_DEFAULT_LIMIT;
    }
    return Math.min(Math.trunc(limit), CLAIM_READ_MODEL_MAX_LIMIT);
  }

  // -------------------------------------------------------------------------
  // Hydration (batched, no per-row N+1)
  // -------------------------------------------------------------------------

  private async hydrate(
    rows: ClaimReadModel[],
    provenance: ReleaseProvenance,
    freshness: ReadModelFreshness,
  ): Promise<ClaimReadModelItem[]> {
    if (rows.length === 0) return [];

    const eventCheckpoints = await this.resolveCanonicalClaimEvents(
      rows,
      provenance,
    );
    const claimIds = rows.map((row) => row.claimId);
    const finalizedBlock =
      freshness.finalizedBlock === null
        ? null
        : BigInt(freshness.finalizedBlock);
    const checkpoint = {
      lastSafeBlock: freshness.safeBlock ?? '0',
      lastFinalizedBlock: freshness.finalizedBlock ?? '0',
    };

    const [evidences, rounds] = await Promise.all([
      this.evidenceRepo.find({
        where: { claimId: In(claimIds), status: EvidenceStatus.ACTIVE },
      }),
      this.roundRepo.find({ where: { claimId: In(claimIds) } }),
    ]);

    const evidenceByClaim = new Map<string, ProjectEvidence[]>();
    for (const evidence of evidences) {
      const list = evidenceByClaim.get(evidence.claimId) ?? [];
      list.push(evidence);
      evidenceByClaim.set(evidence.claimId, list);
    }

    const latestRoundByClaim = new Map<string, ProjectVerificationRound>();
    for (const round of rounds) {
      const current = latestRoundByClaim.get(round.claimId);
      if (!current || this.blockOf(round) > this.blockOf(current)) {
        latestRoundByClaim.set(round.claimId, round);
      }
    }

    return rows.map((row) =>
      toClaimReadModelItem(row, {
        provenance,
        canonicalVerdictCode:
          eventCheckpoints.get(row.claimId)?.verdictCode ?? null,
        dataState: this.finalityPolicy.classifyByCheckpoint(
          row.blockNumber,
          eventCheckpoints.get(row.claimId)?.checkpoint ?? checkpoint,
        ),
        evidence: this.summarizeEvidence(
          evidenceByClaim.get(row.claimId) ?? [],
          finalizedBlock,
        ),
        deadlines: this.summarizeDeadlines(
          latestRoundByClaim.get(row.claimId),
          row.settledAt,
        ),
      }),
    );
  }

  private async resolveCanonicalClaimEvents(
    rows: ClaimReadModel[],
    provenance: ReleaseProvenance,
  ): Promise<
    Map<
      string,
      {
        checkpoint: { lastSafeBlock: string; lastFinalizedBlock: string };
        verdictCode: string | null;
      }
    >
  > {
    const supportedRows = rows.map((row) => {
      if (row.state === ClaimState.Submitted) {
        return {
          row,
          eventName: 'ClaimSubmitted',
          contractAddress: provenance.claimRegistryAddress,
        };
      }
      if (row.state === ClaimState.Finalized) {
        return {
          row,
          eventName: 'VerdictSettled',
          contractAddress: provenance.verdictContractAddress,
        };
      }
      throw this.failClosed(
        'STALE_RECONCILIATION',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Claim lifecycle state has no verified mapping in the bound release',
        'unsupported_claim_lifecycle_state',
        provenance,
      );
    });
    const txHashes = [...new Set(supportedRows.map(({ row }) => row.eventTxHash))];
    const events = await this.canonicalEventRepo.find({
      where: {
        chainId: provenance.chainId,
        txHash: In(txHashes),
        eventName: In(['ClaimSubmitted', 'VerdictSettled']),
      },
    });
    const checkpoints = await this.checkpointRepo.find({
      where: { chainId: provenance.chainId },
    });
    const result = new Map<
      string,
      {
        checkpoint: { lastSafeBlock: string; lastFinalizedBlock: string };
        verdictCode: string | null;
      }
    >();

    for (const { row, eventName, contractAddress } of supportedRows) {
      const matches = events.filter(
        (event) =>
          event.txHash.toLowerCase() === row.eventTxHash.toLowerCase() &&
          event.logIndex === row.eventIndex &&
          event.claimId?.toLowerCase() === row.claimId.toLowerCase() &&
          event.blockNumber === String(row.blockNumber) &&
          event.eventName === eventName,
      );
      if (matches.length !== 1) {
        throw this.failClosed(
          'STALE_RECONCILIATION',
          HttpStatus.SERVICE_UNAVAILABLE,
          'Claim projection has no unique matching canonical source event',
          'canonical_claim_event_missing_or_ambiguous',
          provenance,
        );
      }

      const event = matches[0];
      const artifact = await this.artifactRegistry.resolve(
        event.chainId,
        event.contractAddress,
      );
      if (
        event.contractAddress.toLowerCase() !== contractAddress.toLowerCase() ||
        !artifact ||
        artifact.artifactVersion !== event.artifactVersion ||
        event.artifactVersion !== provenance.artifactVersion
      ) {
        throw this.failClosed(
          'INVALID_ARTIFACT_VERSION',
          HttpStatus.SERVICE_UNAVAILABLE,
          'Claim event is not bound to the approved release artifact',
          'claim_event_artifact_mismatch',
          provenance,
        );
      }

      let outcomeCode: string | null = null;
      if (eventName === 'VerdictSettled') {
        const rawVerdictCode = event.payload?.finalVerdict;
        if (
          typeof rawVerdictCode !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(rawVerdictCode) ||
          BigInt(rawVerdictCode) > 255n
        ) {
          throw this.failClosed(
            'STALE_RECONCILIATION',
            HttpStatus.SERVICE_UNAVAILABLE,
            'Canonical settlement event has a malformed verdict code',
            'malformed_settlement_event',
            provenance,
          );
        }
        outcomeCode = rawVerdictCode;
      }

      const checkpoint = checkpoints.find(
        (candidate) =>
          candidate.contractAddress.toLowerCase() ===
          event.contractAddress.toLowerCase(),
      );
      if (!checkpoint) {
        throw this.failClosed(
          'STALE_RECONCILIATION',
          HttpStatus.SERVICE_UNAVAILABLE,
          'Canonical claim event has no contract finality checkpoint',
          'claim_event_checkpoint_missing',
          provenance,
        );
      }

      let verdictCode: string | null = null;
      if (
        eventName === 'VerdictSettled' &&
        outcomeCode !== null &&
        this.finalityPolicy.classifyByCheckpoint(event.blockNumber, checkpoint) ===
          DataState.FINALIZED
      ) {
        verdictCode = outcomeCode;
      }

      result.set(row.claimId, {
        checkpoint: {
          lastSafeBlock: checkpoint.lastSafeBlock,
          lastFinalizedBlock: checkpoint.lastFinalizedBlock,
        },
        verdictCode,
      });
    }

    return result;
  }

  private summarizeEvidence(
    evidences: ProjectEvidence[],
    finalizedBlock: bigint | null,
  ): EvidenceAvailability {
    let latest: bigint | null = null;
    let finalizedCount = 0;

    for (const evidence of evidences) {
      const block = this.safeBigInt(evidence.lastEventBlockNumber);
      if (block !== null && (latest === null || block > latest)) {
        latest = block;
      }
      if (
        finalizedBlock !== null &&
        block !== null &&
        block <= finalizedBlock
      ) {
        finalizedCount++;
      }
    }

    const activeCount = evidences.length;
    const state =
      activeCount === 0
        ? 'missing'
        : finalizedCount > 0
          ? 'available'
          : 'not_finalized';

    return {
      state,
      activeCount,
      finalizedCount,
      latestBlockNumber: latest === null ? null : latest.toString(),
    };
  }

  private summarizeDeadlines(
    round: ProjectVerificationRound | undefined,
    settledAt: Date | null,
  ): ClaimDeadlines {
    return {
      verification: toIso(round?.deadline),
      appeal: toIso(round?.appealDeadline),
      settledAt: toIso(settledAt),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private failClosed(
    code: ClaimReadModelErrorBody['code'],
    status: number,
    message: string,
    reason: string,
    provenance: ReleaseProvenance | null,
    expected?: Record<string, unknown>,
    received?: Record<string, unknown>,
  ): HttpException {
    if (code !== 'NOT_FOUND') {
      this.logger.warn(`Claim read models fail closed: ${code}/${reason}`);
    }
    const body: ClaimReadModelErrorBody = {
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

  private blockOf(round: ProjectVerificationRound): bigint {
    return this.safeBigInt(round.openedAtBlock) ?? 0n;
  }

  private safeBigInt(value: unknown): bigint | null {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number') {
        return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
      }
      if (typeof value !== 'string') return null;
      const text = value.trim();
      return text === '' ? null : BigInt(text);
    } catch {
      return null;
    }
  }
}
