import { Injectable, Logger } from '@angular/core';

export type IsoDateString = string;

export type ChainId = string;

export type ReleaseId = string;

export type EventId = string;

export type FinalityStatus = 'finalized' | 'provisional' | 'reorged' | 'stale' | 'unavailable';

export type AppealStatus = 'open' | 'expired' | 'appealed' | 'not_appelable' | 'unknown';

export type SettlementOutcome = 'resolved_in_favor_of_claimant' | 'resolved_in_favor_of_respondent' | 'settled_by_mutual_agreement' | 'dismissed' | 'unknown';

export type BondDisposition = 'returned_to_claimant' | 'returned_to_respondent' | 'slashed' | 'forfeited' | 'retained' | 'unknown';

export interface Provenance {
  readonly chainId: ChainId;
  readonly releaseId: ReleaseId;
  readonly eventId: EventId;
  readonly finalityCheckpoint: IsoDateString;
  readonly finalityStatus: FinalityStatus;
}

export interface AppealProjection {
  readonly deadline: IsoDateString | null;
  readonly status: AppealStatus;
  readonly provenance: Provenance | null;
}

export interface SettlementProjection {
  readonly outcome: SettlementOutcome;
  readonly bondDisposition: BondDisposition;
  readonly provenance: Provenance | null;
}

export interface DisputeReadModel {
  readonly disputeId: string;
  readonly appeal: AppealProjection;
  readonly settlement: SettlementProjection;
  readonly finalityStatus: FinalityStatus;
}

export interface CanonicalVerificationRoundAppeal {
  readonly deadline: IsoDateString;
  readonly status: 'open' | 'expired' | 'appealed';
  readonly chainId: ChainId;
  readonly releaseId: ReleaseId;
  readonly eventId: EventId;
  readonly finalityCheckpoint: IsoDateString;
  readonly finalityStatus: FinalityStatus;
}

export interface CanonicalSettlementProjection {
  readonly outcome: Exclude<SettlementOutcome, 'unknown'>;
  readonly bondDisposition: Exclude<BondDisposition, 'unknown'>;
  readonly chainId: ChainId;
  readonly releaseId: ReleaseId;
  readonly eventId: EventId;
  readonly finalityCheckpoint: IsoDateString;
  readonly finalityStatus: FinalityStatus;
}

export interface DisputeReadModelSource {
  getVerificationRoundAppeal(disputeId: string): Promise<CanonicalVerificationRoundAppeal | null>;
  getSettlementProjection(disputeId: string): Promise<CanonicalSettlementProjection | null>;
  getCurrentFinalityCheckpoint(): Promise<IsoDateString>;
}

export const DISPUT_READ_MODEL_SOURCE = Symbol('DISPUT_READ_MODEL_SOURCE');

export class DisputeReadModelSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeReadModelSourceUnavailableError';
  }
}

export class DisputeReadModelStaleProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeReadModelStaleProjectionError';
  }
}

export class DisputeReadModelAmbiguousProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeReadModelAmbiguousProvenanceError';
  }
}

export class DisputeReadModelUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeReadModelUnauthorizedError';
  }
}

export interface DisputeReadModelAccessContext {
  readonly requesterId: string;
  readonly participantIds: ReadonlyArray<string>;
  readonly isAdmin: boolean;
}

export const DISPUTE_READ_MODEL_CACHE_TTL_MS = 60_000;

@Injectable()
export class DisputeReadModelService {
  private readonly logger = new Logger(DisputeReadModelService.name);

  constructor(private readonly source: DisputeReadModelSource) {}

  async getDisputeReadModel(
    disputeId: string,
    access: DisputeReadModelAccessContext,
  ): Promise<DisputeReadModel> {
    this.assertAuthorized(disputeId, access);

    const finalityCheckpoint = await this.resolveFinalityCheckpoint();

    const [appealSource, settlementSource] = await Promise.all([
      this.safeLoad(() => this.source.getVerificationRoundAppeal(disputeId), 'appeal'),
      this.safeLoad(() => this.source.getSettlementProjection(disputeId), 'settlement'),
    ]);

    const appeal = this.projectAppeal(disputeId, appealSource, finalityCheckpoint);
    const settlement = this.projectSettlement(disputeId, settlementSource, finalityCheckpoint);

    const finalityStatus = this.resolveAggregateFinality(appeal, settlement);

    return {
      disputeId,
      appeal,
      settlement,
      finalityStatus,
    };
  }

  private assertAuthorized(disputeId: string, access: DisputeReadModelAccessContext): void {
    if (!disputeId || typeof disputeId !== 'string') {
      throw new DisputeReadModelUnauthorizedError('Dispute identifier is required');
    }
    if (!access || !access.requesterId) {
      throw new DisputeReadModelUnauthorizedError('Requester identity is required');
    }
    if (access.isAdmin) {
      return;
    }
    const isParticipant = access.participantIds.includes(access.requesterId);
    if (!isParticipant) {
      this.logger.warn('Dispute read-model access denied for non-participant');
      throw new DisputeReadModelUnauthorizedError('Requester is not authorized to view this dispute');
    }
  }

  private async resolveFinalityCheckpoint(): Promise<IsoDateString> {
    try {
      const checkpoint = await this.source.getCurrentFinalityCheckpoint();
      if (this.parseIsoDate(checkpoint) === null) {
        throw new DisputeReadModelSourceUnavailableError('Finality checkpoint is unavailable');
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof DisputeReadModelSourceUnavailableError) {
        throw error;
      }
      throw new DisputeReadModelSourceUnavailableError('Failed to resolve finality checkpoint');
    }
  }

  private async safeLoad<T>(
    loader: () => Promise<T | null>,
    label: string,
  ): Promise<T | null> {
    try {
      return await loader();
    } catch {
      this.logger.warn(`Dispute read-model ${label} source unavailable`);
      return null;
    }
  }

  private projectAppeal(
    disputeId: string,
    source: CanonicalVerificationRoundAppeal | null,
    finalityCheckpoint: IsoDateString,
  ): AppealProjection {
    if (!source) {
      return { deadline: null, status: 'unknown', provenance: null };
    }

    this.assertProvenance(disputeId, 'appeal', source, finalityCheckpoint);

    const provenance: Provenance = {
      chainId: source.chainId,
      releaseId: source.releaseId,
      eventId: source.eventId,
      finalityCheckpoint: source.finalityCheckpoint,
      finalityStatus: source.finalityStatus,
    };

    if (source.finalityStatus !== 'finalized') {
      return { deadline: null, status: 'unknown', provenance };
    }

    const deadline = this.parseIsoDate(source.deadline);
    if (deadline === null) {
      throw new DisputeReadModelAmbiguousProvenanceError('Appeal deadline is not a valid ISO date string');
    }

    return {
      deadline: source.deadline,
      status: source.status,
      provenance,
    };
  }

  private projectSettlement(
    disputeId: string,
    source: CanonicalSettlementProjection | null,
    finalityCheckpoint: IsoDateString,
  ): SettlementProjection {
    if (!source) {
      return { outcome: 'unknown', bondDisposition: 'unknown', provenance: null };
    }

    this.assertProvenance(disputeId, 'settlement', source, finalityCheckpoint);

    const provenance: Provenance = {
      chainId: source.chainId,
      releaseId: source.releaseId,
      eventId: source.eventId,
      finalityCheckpoint: source.finalityCheckpoint,
      finalityStatus: source.finalityStatus,
    };

    if (source.finalityStatus !== 'finalized') {
      return { outcome: 'unknown', bondDisposition: 'unknown', provenance };
    }

    return {
      outcome: source.outcome,
      bondDisposition: source.bondDisposition,
      provenance,
    };
  }

  private assertProvenance(
    disputeId: string,
    label: string,
    source: {
      chainId: ChainId;
      releaseId: ReleaseId;
      eventId: EventId;
      finalityCheckpoint: IsoDateString;
      finalityStatus: FinalityStatus;
    },
    finalityCheckpoint: IsoDateString,
  ): void {
    if (!source.chainId || !source.releaseId || !source.eventId) {
      throw new DisputeReadModelAmbiguousProvenanceError(
        `Dispute ${disputeId} ${label} provenance is incomplete (chain/release/event)`,
      );
    }

    const sourceCheckpoint = this.parseIsoDate(source.finalityCheckpoint);
    const currentCheckpoint = this.parseIsoDate(finalityCheckpoint);
    if (sourceCheckpoint === null || currentCheckpoint === null) {
      throw new DisputeReadModelAmbiguousProvenanceError(
        `Dispute ${disputeId} ${label} finality checkpoint is not a valid ISO date`,
      );
    }

    if (source.finalityStatus === 'stale') {
      throw new DisputeReadModelStaleProjectionError(
        `Dispute ${disputeId} ${label} projection is stale`,
      );
    }

    if (source.finalityStatus === 'unavailable') {
      throw new DisputeReadModelSourceUnavailableError(
        `Dispute ${disputeId} ${label} provenance is unavailable`,
      );
    }

    if (source.finalityStatus === 'reorged') {
      throw new DisputeReadModelStaleProjectionError(
        `Dispute ${disputeId} ${label} projection was reorged`,
      );
    }

    if (sourceCheckpoint.getTime() > currentCheckpoint.getTime()) {
      throw new DisputeReadModelStaleProjectionError(
        `Dispute ${disputeId} ${label} provenance is ahead of the current finality checkpoint`,
      );
    }
  }

  private resolveAggregateFinality(
    appeal: AppealProjection,
    settlement: SettlementProjection,
  ): FinalityStatus {
    const statuses = [appeal.provenance?.finalityStatus, settlement.provenance?.finalityStatus].filter(
      (v): v is FinalityStatus => v !== undefined,
    );
    if (statuses.length === 0) {
      return 'unavailable';
    }
    if (statuses.every((s) => s === 'finalized')) {
      return 'finalized';
    }
    if (statuses.some((s) => s === 'reorged')) {
      return 'reorged';
    }
    if (statuses.some((s) => s === 'stale')) {
      return 'stale';
    }
    if (statuses.some((s) => s === 'unavailable')) {
      return 'unavailable';
    }
    return 'provisional';
  }

  private parseIsoDate(value: string | null | undefined): Date | null {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }
}
