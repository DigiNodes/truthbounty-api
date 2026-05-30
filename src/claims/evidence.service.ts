import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Evidence } from './entities/evidence.entity';
import { EvidenceVersion } from './entities/evidence-version.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';

@Injectable()
export class EvidenceService {
  constructor(
    @InjectRepository(Evidence)
    private readonly evidenceRepository: Repository<Evidence>,
    @InjectRepository(EvidenceVersion)
    private readonly evidenceVersionRepository: Repository<EvidenceVersion>,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  async createEvidence(
    claimId: string,
    cid: string,
    userId?: string,
    hash?: string,
  ): Promise<Evidence> {
    const evidence = this.evidenceRepository.create({ claimId, latestVersion: 1 });
    const savedEvidence = await this.evidenceRepository.save(evidence);

    const version = this.evidenceVersionRepository.create({
      evidenceId: savedEvidence.id,
      version: 1,
      cid,
      hash,
      submittedBy: userId,
    });
    await this.evidenceVersionRepository.save(version);

    await this.auditTrailService.log({
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
    const evidence = await this.evidenceRepository.findOneBy({ id: evidenceId });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    const beforeState = { ...evidence };
    const newVersion = evidence.latestVersion + 1;
    evidence.latestVersion = newVersion;
    const updatedEvidence = await this.evidenceRepository.save(evidence);

    const version = this.evidenceVersionRepository.create({
      evidenceId,
      version: newVersion,
      cid,
      hash,
      submittedBy: userId,
    });
    const savedVersion = await this.evidenceVersionRepository.save(version);

    await this.auditTrailService.log({
      actionType: AuditActionType.EVIDENCE_UPDATED,
      entityType: AuditEntityType.EVIDENCE,
      entityId: evidenceId,
      userId,
      description: `Evidence updated to version ${newVersion} with CID: ${cid}`,
      beforeState,
      afterState: updatedEvidence,
    });

    return savedVersion;
  }

  /**
   * Get evidence with all versions
   */
  async getEvidence(evidenceId: string, includeHidden: boolean = false): Promise<Evidence | null> {
    const where: any = { id: evidenceId };
    if (!includeHidden) {
      where.isHidden = false;
    }

  async getEvidence(evidenceId: string): Promise<Evidence | null> {
    return this.evidenceRepository.findOne({
      where,
      relations: ['versions'],
      order: { versions: { version: 'ASC' } },
    });
  }

  /**
   * Get latest version of evidence
   */
  async getLatestEvidenceVersion(
    evidenceId: string,
    includeHidden: boolean = false,
  ): Promise<EvidenceVersion | null> {
    const where: any = { id: evidenceId };
    if (!includeHidden) {
      where.isHidden = false;
    }

    const evidence = await this.evidenceRepository.findOneBy(where);
    if (!evidence) {
      return null;
    }
  async getLatestEvidenceVersion(evidenceId: string): Promise<EvidenceVersion | null> {
    const evidence = await this.evidenceRepository.findOneBy({ id: evidenceId });
    if (!evidence) return null;

    return this.evidenceVersionRepository.findOne({
      where: { evidenceId, version: evidence.latestVersion },
    });
  }

  /**
   * Get all evidence for a claim
   */
  async getEvidenceForClaim(claimId: string, includeHidden: boolean = false): Promise<Evidence[]> {
    const where: any = { claimId };
    if (!includeHidden) {
      where.isHidden = false;
    }

  async getEvidenceForClaim(claimId: string): Promise<Evidence[]> {
    return this.evidenceRepository.find({
      where,
      relations: ['versions'],
      order: { createdAt: 'ASC', versions: { version: 'ASC' } },
    });
  }

  /**
   * Get latest evidence version for a claim (assuming one evidence per claim for simplicity)
   */
  async getLatestEvidenceForClaim(
    claimId: string,
    includeHidden: boolean = false,
  ): Promise<EvidenceVersion | null> {
    const evidences = await this.getEvidenceForClaim(claimId, includeHidden);
    if (evidences.length === 0) {
      return null;
    }
  async getLatestEvidenceForClaim(claimId: string): Promise<EvidenceVersion | null> {
    const evidences = await this.getEvidenceForClaim(claimId);
    if (evidences.length === 0) return null;

    const evidence = evidences[0];
    return this.evidenceVersionRepository.findOne({
      where: { evidenceId: evidence.id, version: evidence.latestVersion },
    });
  }

  async verifyEvidence(evidenceId: string, userId?: string): Promise<Evidence> {
    const evidence = await this.evidenceRepository.findOneBy({ id: evidenceId });
    if (!evidence) {
      throw new NotFoundException(`Evidence with ID ${evidenceId} not found`);
    }

    await this.auditTrailService.log({
      actionType: AuditActionType.EVIDENCE_VERIFIED,
      entityType: AuditEntityType.EVIDENCE,
      entityId: evidenceId,
      userId,
      description: 'Evidence verified by user',
      beforeState: { ...evidence },
      afterState: evidence,
    });

    return evidence;
  }
}
