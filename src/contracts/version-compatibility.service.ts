import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Result of validating decoder-manifest version compatibility.
 */
export interface VersionCompatibilityResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  pinnedVersion: string | null;
  decoderVersion: string | null;
}

/**
 * VersionCompatibilityService
 *
 * Ensures the event decoder uses only the pinned release ABI from the manifest.
 * Rejects stale, ambiguous, or unauthorized ABI versions at startup.
 *
 * Design invariants:
 * - Fail closed: any version mismatch between decoder and manifest fails validation
 * - Pinned releases only: the manifest's releaseId and version must match deployment expectations
 * - No runtime version switching: once validated at startup, the version remains fixed
 * - Explicit drift detection: any attempt to decode with a different version is rejected
 *
 * This satisfies the post-Wave-9 requirement: "Version decoder compatibility explicitly."
 */
@Injectable()
export class VersionCompatibilityService {
  private readonly logger = new Logger(VersionCompatibilityService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Validate that the decoder is using the exact pinned release version
   * specified in the manifest. No fallbacks, no alternate versions.
   *
   * @param manifestVersion The version from the contract manifest
   * @param manifestReleaseId The release ID from the contract manifest
   * @param decoderVersion The version the decoder claims to support
   * @returns Validation result with errors for any incompatibility
   */
  validateDecoderCompatibility(
    manifestVersion: string,
    manifestReleaseId: string | undefined,
    decoderVersion: string,
  ): VersionCompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate manifest version is present and non-empty
    if (!manifestVersion || manifestVersion.trim() === '') {
      errors.push('Manifest version is missing or empty');
    }

    // Validate decoder version is present and non-empty
    if (!decoderVersion || decoderVersion.trim() === '') {
      errors.push('Decoder version is missing or empty');
    }

    // Strict version match: decoder must use exactly the pinned manifest version
    if (
      manifestVersion &&
      decoderVersion &&
      manifestVersion.trim() !== decoderVersion.trim()
    ) {
      errors.push(
        `Version mismatch: decoder claims "${decoderVersion}" but manifest specifies "${manifestVersion}"`,
      );
    }

    // If release ID is present, validate it's properly formatted
    if (manifestReleaseId) {
      if (!/^rel-[a-z0-9]+-\d{8}-v\d+$/i.test(manifestReleaseId)) {
        warnings.push(
          `Release ID "${manifestReleaseId}" does not follow expected format: rel-<network>-<date>-v<number>`,
        );
      }
    } else {
      warnings.push(
        'Manifest does not include a releaseId; pinned release tracking is incomplete',
      );
    }

    // Check for stale pre-release versions in production
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (isProduction && manifestVersion.includes('-')) {
      warnings.push(
        `Production deployment using pre-release version "${manifestVersion}"; ` +
          'only stable releases should be used in production',
      );
    }

    return {
      compatible: errors.length === 0,
      errors,
      warnings,
      pinnedVersion: manifestVersion || null,
      decoderVersion: decoderVersion || null,
    };
  }

  /**
   * Validate that an artifact version matches the pinned manifest version.
   * Used at runtime to ensure the decoder never accidentally uses a different
   * version than what was validated at startup.
   *
   * @param artifactVersion The version from a resolved artifact
   * @param expectedVersion The pinned version from the manifest
   * @returns True if versions match exactly, false otherwise
   */
  isCompatibleArtifactVersion(
    artifactVersion: string,
    expectedVersion: string,
  ): boolean {
    if (!artifactVersion || !expectedVersion) {
      return false;
    }
    return artifactVersion.trim() === expectedVersion.trim();
  }

  /**
   * Validate manifest release binding: ensures all required provenance fields
   * are present for production deployments.
   *
   * Required fields:
   * - version: semantic version of the manifest
   * - releaseId: unique release identifier
   * - chainId: target chain ID
   * - publishedAt: ISO-8601 timestamp
   * - manifestChecksum: SHA-256 of the contracts array
   *
   * @param manifest The manifest to validate
   * @returns Validation result
   */
  validateReleaseBinding(manifest: {
    version?: string;
    releaseId?: string;
    chainId?: number;
    publishedAt?: string;
    manifestChecksum?: string;
    contracts?: Array<{ deployBlock?: number; abiChecksum?: string }>;
  }): VersionCompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required provenance fields
    if (!manifest.version) {
      errors.push('Manifest missing required field: version');
    }
    if (!manifest.releaseId) {
      errors.push('Manifest missing required field: releaseId');
    }
    if (!manifest.chainId) {
      errors.push('Manifest missing required field: chainId');
    }
    if (!manifest.publishedAt) {
      errors.push('Manifest missing required field: publishedAt');
    }
    if (!manifest.manifestChecksum) {
      errors.push('Manifest missing required field: manifestChecksum');
    }

    // Validate contract-level bindings
    if (manifest.contracts) {
      for (let i = 0; i < manifest.contracts.length; i++) {
        const contract = manifest.contracts[i];
        if (contract.deployBlock === undefined || contract.deployBlock < 0) {
          errors.push(`Contract[${i}] missing or invalid deployBlock`);
        }
        if (!contract.abiChecksum || contract.abiChecksum.trim() === '') {
          errors.push(`Contract[${i}] missing abiChecksum`);
        }
      }
    }

    return {
      compatible: errors.length === 0,
      errors,
      warnings,
      pinnedVersion: manifest.version || null,
      decoderVersion: null,
    };
  }

  /**
   * Log the pinned release information for audit trail.
   * Called at startup after successful validation.
   */
  logPinnedRelease(
    manifestVersion: string,
    releaseId: string | undefined,
    chainId: number,
    contractCount: number,
  ): void {
    const releaseInfo = releaseId
      ? `release ${releaseId}, `
      : 'no explicit releaseId, ';
    
    this.logger.log(
      `Decoder locked to pinned manifest: ${releaseInfo}` +
        `version ${manifestVersion}, chain ${chainId}, ${contractCount} contract(s)`,
    );
  }
}
