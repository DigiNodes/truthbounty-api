import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import {
  ApprovedStakingAuthority,
  UnauthorizedProvenanceException,
} from './sybil-resistance.types';

export const STAKING_AUTHORITY_CONFIG_KEYS = {
  chainId: ['SYBIL_STAKING_CHAIN_ID', 'CHAIN_ID'],
  releaseId: [
    'SYBIL_STAKING_RELEASE_ID',
    'CONTRACT_RELEASE_ID',
    'INDEXER_RELEASE_ID',
  ],
  artifactHash: [
    'SYBIL_STAKING_ARTIFACT_HASH',
    'CONTRACT_RELEASE_SHA256',
    'INDEXER_ARTIFACT_CHECKSUM',
  ],
  contractAddress: [
    'SYBIL_STAKING_CONTRACT_ADDRESS',
    'STAKING_CONTRACT_ADDRESS',
  ],
  deploymentBlock: [
    'SYBIL_STAKING_DEPLOYMENT_BLOCK',
    'CONTRACT_RELEASE_DEPLOYMENT_BLOCK',
    'INDEXER_DEPLOYMENT_BLOCK',
  ],
} as const;

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^(0x)?[a-fA-F0-9]{64}$/;

@Injectable()
export class SybilStakingAuthorityService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ContractArtifact)
    private readonly artifactRepo: Repository<ContractArtifact>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
  ) {}

  async resolve(): Promise<ApprovedStakingAuthority> {
    const chainId = this.readPositiveInt(STAKING_AUTHORITY_CONFIG_KEYS.chainId);
    const releaseId = this.readNonEmptyString(
      STAKING_AUTHORITY_CONFIG_KEYS.releaseId,
    );
    const artifactHash = this.readHash(
      STAKING_AUTHORITY_CONFIG_KEYS.artifactHash,
    );
    const contractAddress = this.readAddress(
      STAKING_AUTHORITY_CONFIG_KEYS.contractAddress,
    );
    const deploymentBlock = this.readNonNegativeInt(
      STAKING_AUTHORITY_CONFIG_KEYS.deploymentBlock,
    );

    if (
      chainId === null ||
      releaseId === null ||
      artifactHash === null ||
      contractAddress === null ||
      deploymentBlock === null
    ) {
      throw this.unauthorized('incomplete_runtime_binding');
    }

    await this.assertApprovedArtifact(
      chainId,
      contractAddress,
      artifactHash,
      deploymentBlock,
    );

    const checkpoint = await this.checkpointRepo
      .createQueryBuilder('cp')
      .where('cp.chainId = :chainId', { chainId })
      .andWhere('LOWER(cp.contractAddress) = :contractAddress', {
        contractAddress: contractAddress.toLowerCase(),
      })
      .getOne();

    if (!checkpoint) {
      throw this.unauthorized('finalized_checkpoint_missing');
    }

    const finalizedThroughBlock = Number(checkpoint.lastFinalizedBlock);
    if (
      !Number.isSafeInteger(finalizedThroughBlock) ||
      finalizedThroughBlock < deploymentBlock
    ) {
      throw this.unauthorized('finalized_checkpoint_invalid');
    }

    const safeBlock = Number(checkpoint.lastSafeBlock);
    if (!Number.isSafeInteger(safeBlock) || safeBlock < finalizedThroughBlock) {
      throw this.unauthorized('finalized_checkpoint_invalid');
    }

    const finalizedBlockHash = checkpoint.lastFinalizedBlockHash;
    if (!finalizedBlockHash || !HASH_PATTERN.test(finalizedBlockHash)) {
      throw this.unauthorized('finalized_block_hash_missing');
    }

    const authority: ApprovedStakingAuthority = {
      chainId,
      releaseId,
      artifactHash,
      contractAddress,
      deploymentBlock,
      finalizedThroughBlock,
      finalizedBlockHash: finalizedBlockHash.toLowerCase(),
      source: 'approved_runtime_registry',
      checkpointKey: '',
    };

    return {
      ...authority,
      checkpointKey: this.checkpointKey(authority),
    };
  }

  private async assertApprovedArtifact(
    chainId: number,
    contractAddress: string,
    artifactHash: string,
    deploymentBlock: number,
  ): Promise<void> {
    const artifact = await this.artifactRepo
      .createQueryBuilder('ca')
      .where('ca.chainId = :chainId', { chainId })
      .andWhere('LOWER(ca.contractAddress) = :contractAddress', {
        contractAddress: contractAddress.toLowerCase(),
      })
      .andWhere('ca.isApproved = :isApproved', { isApproved: true })
      .getOne();

    if (!artifact) {
      throw this.unauthorized('contract_artifact_not_approved');
    }

    const approvedChecksum = (artifact.abiChecksum || '').toLowerCase();
    if (
      !approvedChecksum ||
      (approvedChecksum.startsWith('0x')
        ? approvedChecksum.slice(2)
        : approvedChecksum) !== artifactHash.toLowerCase()
    ) {
      throw this.unauthorized('artifact_checksum_mismatch');
    }

    if (
      artifact.deploymentBlock !== null &&
      artifact.deploymentBlock !== undefined
    ) {
      const approvedDeploymentBlock = Number(artifact.deploymentBlock);
      if (
        !Number.isSafeInteger(approvedDeploymentBlock) ||
        approvedDeploymentBlock !== deploymentBlock
      ) {
        throw this.unauthorized('deployment_block_mismatch');
      }
    }
  }

  private checkpointKey(authority: ApprovedStakingAuthority): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          chainId: authority.chainId,
          releaseId: authority.releaseId,
          artifactHash: authority.artifactHash.toLowerCase(),
          contractAddress: authority.contractAddress.toLowerCase(),
          deploymentBlock: authority.deploymentBlock,
          finalizedThroughBlock: authority.finalizedThroughBlock,
          finalizedBlockHash: authority.finalizedBlockHash.toLowerCase(),
          source: authority.source,
        }),
      )
      .digest('hex');
  }

  private unauthorized(reason: string): UnauthorizedProvenanceException {
    return new UnauthorizedProvenanceException(
      `Staking authority unavailable: ${reason}`,
    );
  }

  private readRaw(keys: readonly string[]): string | undefined {
    for (const key of keys) {
      const value = this.configService.get<string | number>(key);
      if (value !== undefined && value !== null && `${value}`.trim() !== '') {
        return `${value}`.trim();
      }
    }
    return undefined;
  }

  private readNonEmptyString(keys: readonly string[]): string | null {
    return this.readRaw(keys) ?? null;
  }

  private readPositiveInt(keys: readonly string[]): number | null {
    const raw = this.readRaw(keys);
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  private readNonNegativeInt(keys: readonly string[]): number | null {
    const raw = this.readRaw(keys);
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  private readAddress(keys: readonly string[]): string | null {
    const raw = this.readRaw(keys);
    return raw && ADDRESS_PATTERN.test(raw) ? raw : null;
  }

  private readHash(keys: readonly string[]): string | null {
    const raw = this.readRaw(keys);
    if (!raw || !HASH_PATTERN.test(raw)) return null;
    return raw.toLowerCase().replace(/^0x/, '');
  }
}
