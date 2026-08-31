import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interface } from 'ethers';
import { ContractArtifact } from './entities/contract-artifact.entity';

export interface ResolvedArtifact {
  artifactVersion: string;
  iface: Interface;
}

/**
 * Resolves the approved ABI for a (chainId, contractAddress) pair.
 *
 * Fails closed: any address without an approved, registered artifact
 * resolves to `null` rather than falling back to a default/legacy ABI, so
 * an unrecognized or unregistered contract can never be silently decoded.
 */
@Injectable()
export class ArtifactRegistryService {
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
    const key = this.cacheKey(chainId, contractAddress);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const row = await this.artifacts.findOne({
      where: {
        chainId,
        contractAddress: contractAddress.toLowerCase(),
        isApproved: true,
      },
    });
    if (!row) return null;

    const resolved: ResolvedArtifact = {
      artifactVersion: row.artifactVersion,
      iface: new Interface(row.abi as never[]),
    };
    this.cache.set(key, resolved);
    return resolved;
  }
}
