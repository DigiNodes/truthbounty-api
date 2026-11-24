import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DisputeReadModelErrorBody,
  ReleaseProvenance,
} from './dispute-read-model.types';

/**
 * Config keys consulted, in priority order, for each provenance field. The
 * `DISPUTE_READ_MODEL_*` names are the explicit override; the generic names let
 * the read model reuse the release manifest values already supplied to the
 * indexer.
 */
export const DISPUTE_READ_MODEL_PROVENANCE_CONFIG_KEYS = {
  chainId: ['DISPUTE_READ_MODEL_CHAIN_ID', 'CHAIN_ID'],
  releaseId: ['DISPUTE_READ_MODEL_RELEASE_ID', 'RELEASE_ID'],
  deploymentBlock: [
    'DISPUTE_READ_MODEL_DEPLOYMENT_BLOCK',
    'RELEASE_DEPLOYMENT_BLOCK',
    'DEPLOYMENT_BLOCK',
  ],
  artifactChecksum: [
    'DISPUTE_READ_MODEL_ARTIFACT_CHECKSUM',
    'RELEASE_ARTIFACT_CHECKSUM',
    'ARTIFACT_CHECKSUM',
  ],
} as const;

const CHECKSUM_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Resolves the release the dispute read models are bound to.
 *
 * Every chain-derived field published by the dispute read models must be
 * attributable to one release (chainId + releaseId + deploymentBlock +
 * artifactChecksum). If any of those cannot be resolved to a valid value the
 * resolver fails closed: it never invents or defaults a release, because a
 * wrong or missing release silently mismatches the frontend's pinned contract.
 */
@Injectable()
export class DisputeReadModelProvenanceService {
  constructor(private readonly configService: ConfigService) {}

  resolve(): ReleaseProvenance {
    const errors: string[] = [];

    const chainId = this.readInt(
      DISPUTE_READ_MODEL_PROVENANCE_CONFIG_KEYS.chainId,
      errors,
      { min: 1 },
    );
    const releaseId = this.readString(
      DISPUTE_READ_MODEL_PROVENANCE_CONFIG_KEYS.releaseId,
      errors,
      { maxLength: 128 },
    );
    const deploymentBlock = this.readInt(
      DISPUTE_READ_MODEL_PROVENANCE_CONFIG_KEYS.deploymentBlock,
      errors,
      { min: 0 },
    );
    const artifactChecksum = this.readChecksum(
      DISPUTE_READ_MODEL_PROVENANCE_CONFIG_KEYS.artifactChecksum,
      errors,
    );

    if (errors.length > 0) {
      const body: DisputeReadModelErrorBody = {
        code: 'STALE_RECONCILIATION',
        message:
          'Release provenance for the dispute read models is unavailable; refusing to serve unbound data',
        failClosed: true,
        reason: errors.join('; '),
        provenance: null,
      };
      throw new ServiceUnavailableException(body);
    }

    return {
      chainId: chainId as number,
      releaseId: releaseId as string,
      deploymentBlock: deploymentBlock as number,
      artifactChecksum: artifactChecksum as string,
    };
  }

  private readString(
    keys: readonly string[],
    errors: string[],
    options: { maxLength: number; minLength?: number },
  ): string | null {
    const raw = this.readRaw(keys);
    if (raw === undefined || raw === null) {
      errors.push(`${keys[0]}_missing`);
      return null;
    }
    const value = String(raw).trim();
    if (value.length === 0) {
      errors.push(`${keys[0]}_empty`);
      return null;
    }
    if (value.length > options.maxLength) {
      errors.push(`${keys[0]}_too_long`);
      return null;
    }
    return value;
  }

  private readInt(
    keys: readonly string[],
    errors: string[],
    options: { min: number },
  ): number | null {
    const raw = this.readRaw(keys);
    if (raw === undefined || raw === null || raw === '') {
      errors.push(`${keys[0]}_missing`);
      return null;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < options.min) {
      errors.push(`${keys[0]}_invalid`);
      return null;
    }
    return value;
  }

  private readChecksum(
    keys: readonly string[],
    errors: string[],
  ): string | null {
    const raw = this.readRaw(keys);
    if (raw === undefined || raw === null) {
      errors.push(`${keys[0]}_missing`);
      return null;
    }
    const value = String(raw).trim().toLowerCase();
    if (!CHECKSUM_PATTERN.test(value)) {
      errors.push(`${keys[0]}_invalid`);
      return null;
    }
    return value.startsWith('0x') ? value.slice(2) : value;
  }

  private readRaw(keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const value = this.configService.get<string | number>(key);
      if (value !== undefined && value !== null && `${value}`.trim() !== '') {
        return `${value}`;
      }
    }
    return undefined;
  }
}
