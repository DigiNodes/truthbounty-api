import { Injectable } from '@nestjs/common';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import {
  EvidenceListQueryDto,
  EvidenceVersionQueryDto,
} from './dto/evidence-query.dto';
import { CidDigest } from './evidence-digest.util';
import { rejectLegacyProtocolOperation } from './protocol-authority';

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

export enum EvidenceAvailability {
  AVAILABLE = 'AVAILABLE',
  ONCHAIN_NOT_REGISTERED = 'ONCHAIN_NOT_REGISTERED',
  OFFCHAIN_UNAVAILABLE = 'OFFCHAIN_UNAVAILABLE',
}

export interface EvidenceAvailabilityStatus {
  evidenceId: string;
  latestVersion: number;
  availability: EvidenceAvailability;
  onChainRegistered: boolean;
  cid?: string;
  gatewayUrl?: string;
}

@Injectable()
export class EvidenceService {
  async createEvidence(
    _claimId: string,
    _cid: string,
    _userId?: string,
    _hash?: string,
  ): Promise<Evidence> {
    return rejectLegacyProtocolOperation(
      'The API cannot register evidence. Submit a user-authorized contract transaction and wait for its canonical event.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async addEvidenceVersion(
    _evidenceId: string,
    _cid: string,
    _userId?: string,
    _hash?: string,
  ): Promise<EvidenceVersion> {
    return rejectLegacyProtocolOperation(
      'The API cannot replace registered evidence. Submit a user-authorized replacement transaction and wait for its canonical event.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getEvidence(_evidenceId: string): Promise<Evidence | null> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getEvidenceOrFail(_evidenceId: string): Promise<Evidence> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getLatestEvidenceVersion(
    _evidenceId: string,
  ): Promise<EvidenceVersion | null> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence versions are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getEvidenceForClaim(_claimId: string): Promise<Evidence[]> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getLatestEvidenceForClaim(
    _claimId: string,
  ): Promise<EvidenceVersion | null> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async listEvidence(_query: EvidenceListQueryDto): Promise<Paginated<Evidence>> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence rows are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async listEvidenceVersions(
    _evidenceId: string,
    _query: EvidenceVersionQueryDto,
  ): Promise<Paginated<EvidenceVersion>> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence versions are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getContentDigest(
    _evidenceId: string,
    _requestedVersion?: number,
  ): Promise<CidDigest> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence digests are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getSafeGateway(
    _evidenceId: string,
    _requestedVersion?: number,
  ): Promise<{ cid: string; gatewayUrl?: string }> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence CIDs are not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }

  async getAvailabilityStatus(
    _evidenceId: string,
  ): Promise<EvidenceAvailabilityStatus> {
    return rejectLegacyProtocolOperation(
      'Legacy evidence status is not canonical. Query the V2 event projection by claim ID.',
      '/v2/claims/{claimId}/evidence',
    );
  }
}
