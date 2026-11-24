import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interface } from 'ethers';
import * as crypto from 'crypto';
import { ContractArtifact } from './entities/contract-artifact.entity';

export interface ResolvedArtifact {
  artifactVersion: string;
  iface: Interface;
}

/** Discriminated artifact resolution, used to classify quarantine failures. */
export type ArtifactResolution =
  | {
      status: 'ok';
      artifactVersion: string;
      iface: Interface;
      abiChecksum: string;
    }
  | { status: 'unregistered' }
  | { status: 'invalid_artifact'; detail: string };

/**
 * Resolves the approved ABI for a (chainId, contractAddress) pair.
 *
 * Fails closed: any address without an approved, registered artifact
 * resolves to `null` rather than falling back to a default/legacy ABI, so
 * an unrecognized or unregistered contract can never be silently decoded.
 */
@Injectable()
export class ArtifactRegistryService {
  private readonly logger = new Logger(ArtifactRegistryService.name);
  private readonly cache = new Map<string, ResolvedArtifact>();

  constructor(
    @InjectRepository(ContractArtifact)
    private readonly artifacts: Repository<ContractArtifact>,
  ) {}

  private cacheKey(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /** Invalidate the in-memory cache, e.g. after registering/approving an artifact. */
  clearCache(): void {
    this.cache.clear();
  }

  async resolve(
    chainId: number,
    contractAddress: string,
  ): Promise<ResolvedArtifact | null> {
    if (
      !Number.isInteger(chainId) ||
      !this.isSupportedChain(chainId) ||
      typeof contractAddress !== 'string' ||
      contractAddress.trim() === '' ||
      !/^0x[a-fA-F0-9]{40}$/.test(contractAddress.trim())
    ) {
      return null;
    }

    const normalizedAddress = contractAddress.trim().toLowerCase();
    const key = this.cacheKey(chainId, normalizedAddress);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const row = await this.artifacts.findOne({
      where: {
        chainId,
        contractAddress: normalizedAddress,
        isApproved: true,
      },
    });
    if (!row) return null;

    if (
      !row.artifactVersion.trim() ||
      !this.isEvmAddress(row.contractAddress) ||
      row.contractAddress !== row.contractAddress.toLowerCase()
    ) {
      this.logInvalidArtifact(row, 'missing version or invalid address');
      return null;
    }

    const checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(row.abi))
      .digest('hex');
    if (
      !/^[a-f0-9]{64}$/.test(row.abiChecksum) ||
      row.abiChecksum !== checksum
    ) {
      this.logInvalidArtifact(row, 'ABI checksum mismatch');
      return null;
    }

    try {
      const iface = new Interface(row.abi as never[]);
      if (
        iface.fragments.length !== row.abi.length ||
        iface.fragments.length === 0
      ) {
        this.logInvalidArtifact(
          row,
          'ABI is empty or contains invalid fragments',
        );
        return null;
      }

      const resolved: ResolvedArtifact = {
        artifactVersion: row.artifactVersion,
        iface,
      };
      this.cache.set(key, resolved);
      return resolved;
    } catch (error) {
      this.logInvalidArtifact(
        row,
        `ABI is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private isSupportedChain(chainId: number): boolean {
    return chainId === 10 || chainId === 11155420;
  }

  /**
   * Resolve an artifact with a discriminated result, so callers can tell an
   * unknown address (`unregistered`) from an approved row that failed validation
   * (`invalid_artifact`, i.e. an ABI mismatch). Used to classify quarantine.
   */
  async resolveDetailed(
    chainId: number,
    contractAddress: string,
  ): Promise<ArtifactResolution> {
    const resolved = await this.resolve(chainId, contractAddress);
    if (resolved) {
      const row = await this.artifacts.findOne({
        where: {
          chainId,
          contractAddress: contractAddress.trim().toLowerCase(),
          isApproved: true,
        },
      });
      const abiChecksum = row
        ? crypto
            .createHash('sha256')
            .update(JSON.stringify(row.abi))
            .digest('hex')
        : '';
      return {
        status: 'ok',
        artifactVersion: resolved.artifactVersion,
        iface: resolved.iface,
        abiChecksum,
      };
    }

    if (
      !Number.isInteger(chainId) ||
      !this.isSupportedChain(chainId) ||
      typeof contractAddress !== 'string' ||
      !this.isEvmAddress(contractAddress.trim())
    ) {
      return { status: 'unregistered' };
    }

    const row = await this.artifacts.findOne({
      where: { chainId, contractAddress: contractAddress.trim().toLowerCase() },
    });
    if (!row) return { status: 'unregistered' };
    return {
      status: 'invalid_artifact',
      detail: row.isApproved
        ? 'approved artifact failed checksum/ABI validation'
        : 'artifact exists but is not approved',
    };
  }

  private isEvmAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  private logInvalidArtifact(artifact: ContractArtifact, reason: string): void {
    // Invalid rows are treated as absent by callers; the warning preserves an
    // actionable signal without allowing unverified ABI data into the index.
    this.logger.warn(
      `Rejected contract artifact ${artifact.chainId}:${artifact.contractAddress}: ${reason}`,
    );
  }
}
