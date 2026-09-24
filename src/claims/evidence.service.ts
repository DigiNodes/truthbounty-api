import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import {
  AuditTrailService,
  AuditLogInput,
} from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';
import { IpfsService } from '../ipfs/ipfs.service';
import {
  EvidenceListQueryDto,
  EvidenceVersionQueryDto,
} from './dto/evidence-query.dto';
import { CidDigest, extractCidDigest } from './evidence-digest.util';

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

/**
 * Distinct availability outcome separating missing on-chain registration from
 * unavailable off-chain content:
 *
 * - ONCHAIN_NOT_REGISTERED: the indexer has not projected an on-chain
 *   registration for this evidence aggregate. This is a registration (state)
 *   problem, not a content problem.
 * - OFFCHAIN_UNAVAILABLE: the evidence is registered on-chain but the
 *   off-chain content (CID / safe gateway) is not currently available.
 * - AVAILABLE: registered on-chain and off-chain content is addressable via a
 *   safe gateway.
 */
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
  constructor(
    @InjectRepository(Evidence)
    private readonly evidenceRepository: Repository<Evidence>,
    @InjectRepository(EvidenceVersion)
    private readonly evidenceVersionRepository: Repository<EvidenceVersion>,
    private readonly auditTrailService: AuditTrailService,
    private readonly ipfsService: IpfsService,
  ) {}

  // ─── Write / mutate paths (unchanged behaviour, rebuilt cleanly) ──────────

  async createEvidence(
    claimId: string,
    cid: string,
    userId?: string,
    hash?: string,
  ): Promise<Evidence> {
    const evidence = this.evidenceRepository.create({
      claimId,
      latestVersion: 1,
    });
    const savedEvidence = await this.evidenceRepository.save(evidence);

    const version = this.evidenceVersionRepository.create({
      evidenceId: savedEvidence.id,
      version: 1,
      cid,
      hash,
      submittedBy: userId,
    });
    await this.evidenceVersionRepository.save(version);

    await this.safeAudit({
      actionType: AuditActionType.EVIDENCE_SUBMITTED,
      entityType: AuditEntityType.EVIDENCE,
      entityId: savedEvidence.id,
      userId,
      description: `Evidence submitted for claim ${claimId} with CID: ${cid}`,
      afterState: { id: savedEvidence.id, claimId, version: 1, cid, hash },
    });

    return savedEvidence;
  }

  async addEvidenceVersion(
    evidenceId: string,
    cid: string,
    userId?: string,
    hash?: string,
  ): Promise<EvidenceVersion> {
    const evidence = await this.evidenceRepository.findOneBy({
      id: evidenceId,
    });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const newVersion = evidence.latestVersion + 1;
    const version = this.evidenceVersionRepository.create({
      evidenceId,
      version: newVersion,
      cid,
      hash,
      submittedBy: userId,
    });
    const savedVersion = await this.evidenceVersionRepository.save(version);

    evidence.latestVersion = newVersion;
    await this.evidenceRepository.save(evidence);

    await this.safeAudit({
      actionType: AuditActionType.EVIDENCE_UPDATED,
      entityType: AuditEntityType.EVIDENCE,
      entityId: evidenceId,
      userId,
      description: `Evidence updated to version ${newVersion} with CID: ${cid}`,
      afterState: { id: evidenceId, version: newVersion, cid, hash },
    });

    return savedVersion;
  }

  // ─── Read paths (legacy shape) ────────────────────────────────────────────

  async getEvidence(evidenceId: string): Promise<Evidence | null> {
    return this.evidenceRepository.findOne({
      where: { id: evidenceId },
      relations: ['versions'],
      order: { versions: { version: 'ASC' } },
    });
  }

  async getEvidenceOrFail(evidenceId: string): Promise<Evidence> {
    const evidence = await this.getEvidence(evidenceId);
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }
    return evidence;
  }

  async getLatestEvidenceVersion(
    evidenceId: string,
  ): Promise<EvidenceVersion | null> {
    const evidence = await this.evidenceRepository.findOneBy({
      id: evidenceId,
    });
    if (!evidence) return null;
    return this.evidenceVersionRepository.findOneBy({
      evidenceId,
      version: evidence.latestVersion,
    });
  }

  async getEvidenceForClaim(claimId: string): Promise<Evidence[]> {
    return this.evidenceRepository.find({
      where: { claimId },
      relations: ['versions'],
      order: { createdAt: 'ASC', versions: { version: 'ASC' } },
    });
  }

  async getLatestEvidenceForClaim(
    claimId: string,
  ): Promise<EvidenceVersion | null> {
    const evidences = await this.getEvidenceForClaim(claimId);
    if (evidences.length === 0) return null;
    const evidence = evidences[0];
    return this.evidenceVersionRepository.findOneBy({
      evidenceId: evidence.id,
      version: evidence.latestVersion,
    });
  }

  // ─── V2-BE-025 query surface ──────────────────────────────────────────────

  /**
   * List evidence with bounded pagination and deterministic ordering
   * (created ASC for a stable cursor across pages, keyed by id for ties).
   */
  async listEvidence(
    query: EvidenceListQueryDto,
  ): Promise<Paginated<Evidence>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = query.claimId !== undefined ? { claimId: query.claimId } : {};

    const [rows, total] = await this.evidenceRepository.findAndCount({
      where,
      relations: ['versions'],
      skip,
      take: limit,
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  /**
   * List the versions of an evidence aggregate with deterministic ordering
   * (version DESC, newest first).
   */
  async listEvidenceVersions(
    evidenceId: string,
    query: EvidenceVersionQueryDto,
  ): Promise<Paginated<EvidenceVersion>> {
    const evidence = await this.evidenceRepository.findOneBy({
      id: evidenceId,
    });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [rows, total] = await this.evidenceVersionRepository.findAndCount({
      where: { evidenceId },
      skip,
      take: limit,
      order: { version: 'DESC' },
    });

    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  /**
   * Resolve a specific version (or the latest) for an evidence aggregate.
   */
  private async resolveVersion(
    evidenceId: string,
    requestedVersion?: number,
  ): Promise<EvidenceVersion> {
    const evidence = await this.evidenceRepository.findOneBy({
      id: evidenceId,
    });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    if (requestedVersion === undefined) {
      const latest = await this.evidenceVersionRepository.findOneBy({
        evidenceId,
        version: evidence.latestVersion,
      });
      if (!latest) {
        throw new NotFoundException(
          `No versions exist for Evidence with ID ${evidenceId}`,
        );
      }
      return latest;
    }

    const version = await this.evidenceVersionRepository.findOneBy({
      evidenceId,
      version: requestedVersion,
    });
    if (!version) {
      throw new NotFoundException(
        `Evidence ${evidenceId} has no version ${requestedVersion}`,
      );
    }
    return version;
  }

  /**
   * Content digest for an evidence version. The CID itself carries the
   * multihash content digest; this validates the CID is parseable before
   * exposing it.
   */
  async getContentDigest(
    evidenceId: string,
    requestedVersion?: number,
  ): Promise<CidDigest> {
    const version = await this.resolveVersion(evidenceId, requestedVersion);
    const digest = extractCidDigest(version.cid);
    if (!digest) {
      throw new BadRequestException(
        `CID stored on Evidence ${evidenceId} version ${version.version} is not a valid CID`,
      );
    }
    return digest;
  }

  /**
   * Safe gateway metadata for an evidence version. The URL is produced by the
   * IpfsService gateway sanitizer and is undefined when no safe gateway
   * address is available (e.g. local-only provider or unsafe input).
   */
  async getSafeGateway(
    evidenceId: string,
    requestedVersion?: number,
  ): Promise<{ cid: string; gatewayUrl?: string }> {
    const version = await this.resolveVersion(evidenceId, requestedVersion);
    const gatewayUrl = this.ipfsService.getGatewayUrl(version.cid);
    return { cid: version.cid, gatewayUrl };
  }

  /**
   * Distinguish missing on-chain registration from unavailable off-chain
   * content. Registration is event-derived (the indexer projection), while
   * content availability depends on whether a safe gateway can address the CID.
   */
  async getAvailabilityStatus(
    evidenceId: string,
  ): Promise<EvidenceAvailabilityStatus> {
    const evidence = await this.evidenceRepository.findOneBy({
      id: evidenceId,
    });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const latest = await this.evidenceVersionRepository.findOneBy({
      evidenceId,
      version: evidence.latestVersion,
    });

    if (!evidence.onChainRegistered) {
      return {
        evidenceId,
        latestVersion: evidence.latestVersion,
        availability: EvidenceAvailability.ONCHAIN_NOT_REGISTERED,
        onChainRegistered: false,
      };
    }

    const cid = latest?.cid;
    if (!cid) {
      return {
        evidenceId,
        latestVersion: evidence.latestVersion,
        availability: EvidenceAvailability.OFFCHAIN_UNAVAILABLE,
        onChainRegistered: true,
      };
    }

    const gatewayUrl = this.ipfsService.getGatewayUrl(cid);
    if (!gatewayUrl) {
      return {
        evidenceId,
        latestVersion: evidence.latestVersion,
        availability: EvidenceAvailability.OFFCHAIN_UNAVAILABLE,
        onChainRegistered: true,
        cid,
      };
    }

    return {
      evidenceId,
      latestVersion: evidence.latestVersion,
      availability: EvidenceAvailability.AVAILABLE,
      onChainRegistered: true,
      cid,
      gatewayUrl,
    };
  }

  private async safeAudit(input: AuditLogInput): Promise<void> {
    try {
      await this.auditTrailService.log(input);
    } catch {
      // Audit failures must never break the evidence write path.
    }
  }
}
