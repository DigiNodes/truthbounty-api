import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import {
  ProjectEvidence,
  EvidenceStatus,
} from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';

/**
 * Fields used to compute ProjectEvidenceVersion integrity hash.
 * Excludes: id (UUID), createdAt (backend timestamp), integrityHash itself.
 */
export interface VersionHashableFields {
  evidenceId: string;
  version: number;
  contentDigest: string;
  safeMetadataUri: string | null;
  submittedBy: string | null;
  eventTxHash: string;
  eventLogIndex: number;
  blockNumber: string; // bigint as string
  previousVersionHash: string | null;
}

/**
 * Fields used to compute ProjectEvidence integrity hash.
 * Excludes: createdAt, updatedAt (backend timestamps), integrityHash itself.
 */
export interface EvidenceHashableFields {
  evidenceId: string;
  claimId: string;
  currentVersion: number;
  status: EvidenceStatus;
  contentDigest: string;
  lastEventBlockNumber: string;
  lastEventLogIndex: number;
}

/**
 * Result of integrity verification.
 */
export interface IntegrityVerificationResult {
  valid: boolean;
  entityId: string;
  entityType: 'evidence' | 'version';
  integrityHash?: string;
  expectedHash?: string;
  reason?: 'hash_missing' | 'hash_mismatch' | 'chain_break' | 'not_found';
  details?: string;
}

/**
 * Chain-of-custody verification result for evidence version history.
 */
export interface ChainOfCustodyResult {
  valid: boolean;
  evidenceId: string;
  totalVersions: number;
  brokenAt?: number; // version number where chain breaks
  reason?: string;
}

/**
 * Service for computing and verifying cryptographic integrity hashes
 * for V2 evidence projections.
 *
 * Implements deterministic, collision-resistant hash computation using SHA-256
 * with normalized, sorted field serialization. Enables detection of database
 * corruption, unauthorized mutation, and reorg-induced inconsistencies.
 *
 * @see docs/V2_EVIDENCE_INTEGRITY_DESIGN.md
 */
@Injectable()
export class EvidenceIntegrityService {
  private readonly logger = new Logger(EvidenceIntegrityService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Compute deterministic SHA-256 integrity hash for a version record.
   *
   * Hash input includes all canonical fields from the chain event, plus
   * previousVersionHash to enable chain-of-custody verification.
   *
   * Algorithm:
   * 1. Extract hashable fields (excluding id, createdAt, integrityHash)
   * 2. Normalize values (null preservation, bigint → string)
   * 3. Sort keys alphabetically for determinism
   * 4. JSON.stringify with sorted keys
   * 5. SHA-256 hash → hex digest
   *
   * @param version - Partial or complete ProjectEvidenceVersion record
   * @returns 64-character hex hash string
   */
  computeVersionHash(
    version: Partial<ProjectEvidenceVersion> & VersionHashableFields,
  ): string {
    const normalized: VersionHashableFields = {
      evidenceId: version.evidenceId,
      version: version.version,
      contentDigest: version.contentDigest,
      safeMetadataUri: version.safeMetadataUri ?? null,
      submittedBy: version.submittedBy ?? null,
      eventTxHash: version.eventTxHash,
      eventLogIndex: version.eventLogIndex,
      blockNumber: String(version.blockNumber), // Ensure string representation
      previousVersionHash: version.previousVersionHash ?? null,
    };

    // Sort keys for deterministic serialization
    const sortedKeys = Object.keys(normalized).sort();
    const serialized = JSON.stringify(normalized, sortedKeys);

    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Compute deterministic SHA-256 integrity hash for current-state evidence record.
   *
   * Hash input includes all projection state fields derived from canonical events.
   *
   * @param evidence - Partial or complete ProjectEvidence record
   * @returns 64-character hex hash string
   */
  computeEvidenceHash(
    evidence: Partial<ProjectEvidence> & EvidenceHashableFields,
  ): string {
    const normalized: EvidenceHashableFields = {
      evidenceId: evidence.evidenceId,
      claimId: evidence.claimId,
      currentVersion: evidence.currentVersion,
      status: evidence.status,
      contentDigest: evidence.contentDigest,
      lastEventBlockNumber: String(evidence.lastEventBlockNumber),
      lastEventLogIndex: evidence.lastEventLogIndex,
    };

    const sortedKeys = Object.keys(normalized).sort();
    const serialized = JSON.stringify(normalized, sortedKeys);

    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Verify integrity of a single evidence version.
   *
   * Recomputes the hash from canonical fields and compares against stored hash.
   * Does NOT verify chain-of-custody (use verifyChainOfCustody for that).
   *
   * @param evidenceId - Evidence identifier
   * @param version - Version number
   * @returns Verification result with failure reason if invalid
   */
  async verifyVersionIntegrity(
    evidenceId: string,
    version: number,
  ): Promise<IntegrityVerificationResult> {
    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);
    const record = await versionRepo.findOne({
      where: { evidenceId, version },
    });

    if (!record) {
      return {
        valid: false,
        entityId: `${evidenceId}:v${version}`,
        entityType: 'version',
        reason: 'not_found',
      };
    }

    if (!record.integrityHash) {
      return {
        valid: false,
        entityId: `${evidenceId}:v${version}`,
        entityType: 'version',
        reason: 'hash_missing',
        details: 'Record has not been stamped with integrity hash',
      };
    }

    const expectedHash = this.computeVersionHash(record);
    const valid = expectedHash === record.integrityHash;

    return {
      valid,
      entityId: `${evidenceId}:v${version}`,
      entityType: 'version',
      integrityHash: record.integrityHash,
      expectedHash,
      reason: valid ? undefined : 'hash_mismatch',
      details: valid
        ? undefined
        : `Expected ${expectedHash}, got ${record.integrityHash}`,
    };
  }

  /**
   * Verify integrity of current-state evidence projection.
   *
   * @param evidenceId - Evidence identifier
   * @returns Verification result with failure reason if invalid
   */
  async verifyEvidenceIntegrity(
    evidenceId: string,
  ): Promise<IntegrityVerificationResult> {
    const evidenceRepo = this.dataSource.getRepository(ProjectEvidence);
    const record = await evidenceRepo.findOne({ where: { evidenceId } });

    if (!record) {
      return {
        valid: false,
        entityId: evidenceId,
        entityType: 'evidence',
        reason: 'not_found',
      };
    }

    if (!record.integrityHash) {
      return {
        valid: false,
        entityId: evidenceId,
        entityType: 'evidence',
        reason: 'hash_missing',
        details: 'Record has not been stamped with integrity hash',
      };
    }

    const expectedHash = this.computeEvidenceHash(record);
    const valid = expectedHash === record.integrityHash;

    return {
      valid,
      entityId: evidenceId,
      entityType: 'evidence',
      integrityHash: record.integrityHash,
      expectedHash,
      reason: valid ? undefined : 'hash_mismatch',
      details: valid
        ? undefined
        : `Expected ${expectedHash}, got ${record.integrityHash}`,
    };
  }

  /**
   * Verify cryptographic chain-of-custody for all versions of evidence.
   *
   * Validates that each version N's previousVersionHash equals version N-1's
   * integrityHash, ensuring no tampering or missing versions.
   *
   * @param evidenceId - Evidence identifier
   * @returns Chain verification result with break location if invalid
   */
  async verifyChainOfCustody(
    evidenceId: string,
  ): Promise<ChainOfCustodyResult> {
    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);
    const versions = await versionRepo.find({
      where: { evidenceId },
      order: { version: 'ASC' },
    });

    if (versions.length === 0) {
      return {
        valid: false,
        evidenceId,
        totalVersions: 0,
        reason: 'No versions found',
      };
    }

    // Version 1 should have null previousVersionHash
    if (versions[0].version !== 1) {
      return {
        valid: false,
        evidenceId,
        totalVersions: versions.length,
        brokenAt: versions[0].version,
        reason: `First version is ${versions[0].version}, expected 1`,
      };
    }

    if (versions[0].previousVersionHash !== null) {
      return {
        valid: false,
        evidenceId,
        totalVersions: versions.length,
        brokenAt: 1,
        reason: 'Version 1 has non-null previousVersionHash',
      };
    }

    // Verify chain links
    for (let i = 1; i < versions.length; i++) {
      const currentVersion = versions[i];
      const previousVersion = versions[i - 1];

      // Check version sequence
      if (currentVersion.version !== previousVersion.version + 1) {
        return {
          valid: false,
          evidenceId,
          totalVersions: versions.length,
          brokenAt: currentVersion.version,
          reason: `Version gap: ${previousVersion.version} → ${currentVersion.version}`,
        };
      }

      // Check hash chain
      if (currentVersion.previousVersionHash !== previousVersion.integrityHash) {
        return {
          valid: false,
          evidenceId,
          totalVersions: versions.length,
          brokenAt: currentVersion.version,
          reason: `Chain break: previousVersionHash (${currentVersion.previousVersionHash}) != previous integrityHash (${previousVersion.integrityHash})`,
        };
      }
    }

    return {
      valid: true,
      evidenceId,
      totalVersions: versions.length,
    };
  }

  /**
   * Verify complete integrity of an evidence item: current state, all versions,
   * and chain-of-custody.
   *
   * @param evidenceId - Evidence identifier
   * @returns Comprehensive verification results
   */
  async verifyCompleteIntegrity(evidenceId: string): Promise<{
    evidenceValid: boolean;
    versionsValid: boolean;
    chainValid: boolean;
    evidenceResult: IntegrityVerificationResult;
    versionResults: IntegrityVerificationResult[];
    chainResult: ChainOfCustodyResult;
  }> {
    const evidenceResult = await this.verifyEvidenceIntegrity(evidenceId);

    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);
    const versions = await versionRepo.find({
      where: { evidenceId },
      order: { version: 'ASC' },
    });

    const versionResults: IntegrityVerificationResult[] = [];
    for (const version of versions) {
      const result = await this.verifyVersionIntegrity(
        evidenceId,
        version.version,
      );
      versionResults.push(result);
    }

    const chainResult = await this.verifyChainOfCustody(evidenceId);

    return {
      evidenceValid: evidenceResult.valid,
      versionsValid: versionResults.every((r) => r.valid),
      chainValid: chainResult.valid,
      evidenceResult,
      versionResults,
      chainResult,
    };
  }

  /**
   * Get the integrity hash of a specific version for chain linking.
   *
   * @param evidenceId - Evidence identifier
   * @param version - Version number
   * @returns Integrity hash or null if not found/not stamped
   */
  async getPreviousVersionHash(
    evidenceId: string,
    version: number,
  ): Promise<string | null> {
    if (version < 1) return null;

    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);
    const record = await versionRepo.findOne({
      where: { evidenceId, version },
      select: ['integrityHash'],
    });

    return record?.integrityHash ?? null;
  }

  /**
   * Backfill integrity hashes for existing records (migration Phase 2).
   *
   * Stamps versions in order to ensure correct previousVersionHash chaining.
   * Runs in batches to avoid memory exhaustion on large datasets.
   *
   * @param batchSize - Number of records to process per batch
   * @returns Summary of stamped records
   */
  async stampExistingRecords(
    batchSize = 100,
  ): Promise<{ versions: number; evidence: number; errors: number }> {
    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);
    const evidenceRepo = this.dataSource.getRepository(ProjectEvidence);

    let versionCount = 0;
    let evidenceCount = 0;
    let errorCount = 0;

    // Stamp versions in strict order
    this.logger.log('Starting version integrity hash backfill...');

    let offset = 0;
    while (true) {
      const versions = await versionRepo.find({
        where: { integrityHash: IsNull() },
        order: { evidenceId: 'ASC', version: 'ASC' },
        take: batchSize,
        skip: offset,
      });

      if (versions.length === 0) break;

      for (const version of versions) {
        try {
          // Get previous version hash for chaining
          const prevHash = await this.getPreviousVersionHash(
            version.evidenceId,
            version.version - 1,
          );
          version.previousVersionHash = prevHash;

          // Compute and stamp hash
          const hash = this.computeVersionHash(version);
          version.integrityHash = hash;

          await versionRepo.save(version);
          versionCount++;
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to stamp version ${version.evidenceId}:v${version.version}: ${error.message}`,
            error.stack,
          );
        }
      }

      offset += batchSize;
      this.logger.log(`Stamped ${versionCount} versions so far...`);
    }

    // Stamp current-state evidence projections
    this.logger.log('Starting evidence integrity hash backfill...');

    offset = 0;
    while (true) {
      const evidence = await evidenceRepo.find({
        where: { integrityHash: IsNull() },
        order: { evidenceId: 'ASC' },
        take: batchSize,
        skip: offset,
      });

      if (evidence.length === 0) break;

      for (const item of evidence) {
        try {
          const hash = this.computeEvidenceHash(item);
          item.integrityHash = hash;
          await evidenceRepo.save(item);
          evidenceCount++;
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to stamp evidence ${item.evidenceId}: ${error.message}`,
            error.stack,
          );
        }
      }

      offset += batchSize;
      this.logger.log(`Stamped ${evidenceCount} evidence records so far...`);
    }

    this.logger.log(
      `Backfill complete: ${versionCount} versions, ${evidenceCount} evidence, ${errorCount} errors`,
    );

    return {
      versions: versionCount,
      evidence: evidenceCount,
      errors: errorCount,
    };
  }

  /**
   * Batch verify integrity of multiple evidence items.
   *
   * @param evidenceIds - Array of evidence identifiers
   * @returns Array of verification results
   */
  async verifyBatch(
    evidenceIds: string[],
  ): Promise<IntegrityVerificationResult[]> {
    const results: IntegrityVerificationResult[] = [];

    for (const evidenceId of evidenceIds) {
      const result = await this.verifyEvidenceIntegrity(evidenceId);
      results.push(result);
    }

    return results;
  }

  /**
   * Get integrity statistics for monitoring dashboards.
   *
   * @returns Summary of integrity status across all evidence
   */
  async getIntegrityStatistics(): Promise<{
    totalEvidence: number;
    totalVersions: number;
    evidenceStamped: number;
    versionsStamped: number;
    evidenceUnstamped: number;
    versionsUnstamped: number;
  }> {
    const evidenceRepo = this.dataSource.getRepository(ProjectEvidence);
    const versionRepo = this.dataSource.getRepository(ProjectEvidenceVersion);

    const [totalEvidence, evidenceUnstamped, totalVersions, versionsUnstamped] =
      await Promise.all([
        evidenceRepo.count(),
        evidenceRepo.count({ where: { integrityHash: IsNull() } }),
        versionRepo.count(),
        versionRepo.count({ where: { integrityHash: IsNull() } }),
      ]);

    return {
      totalEvidence,
      totalVersions,
      evidenceStamped: totalEvidence - evidenceUnstamped,
      versionsStamped: totalVersions - versionsUnstamped,
      evidenceUnstamped,
      versionsUnstamped,
    };
  }
}
