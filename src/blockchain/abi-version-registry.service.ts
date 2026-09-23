import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { createHash } from 'crypto';
import { AbiVersionRegistry } from './entities/abi-version-registry.entity';

export interface RegisterAbiDto {
  contractAddress: string;
  chainId: number;
  deployedAtBlock: number;
  version: string;
  abi: object[];
}

/**
 * V2-BE-099: Version ABI Decoding Across Deployments
 *
 * Stores and resolves the canonical ABI for a contract address at a given
 * block number so the indexer can decode events across multiple deployments
 * without ambiguity or silent fallback to an incorrect ABI.
 *
 * Invariants:
 * - A (contractAddress, chainId, deployedAtBlock) triple must be unique.
 * - ABI drift is detected via SHA-256 hash comparison on registration.
 * - Resolution is deterministic: returns the entry with the highest
 *   deployedAtBlock that is <= the queried block number.
 * - Throws (fail-closed) when no matching ABI exists; never fabricates state.
 */
@Injectable()
export class AbiVersionRegistryService {
  private readonly logger = new Logger(AbiVersionRegistryService.name);

  constructor(
    @InjectRepository(AbiVersionRegistry)
    private readonly repo: Repository<AbiVersionRegistry>,
  ) {}

  /**
   * Register or update an ABI version for a deployment.
   * Detects hash drift and logs a warning when the ABI changes at the same
   * (contractAddress, chainId, deployedAtBlock) coordinates.
   */
  async register(dto: RegisterAbiDto): Promise<AbiVersionRegistry> {
    const { contractAddress, chainId, deployedAtBlock, version, abi } = dto;

    if (!contractAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new BadRequestException('contractAddress must be a valid 0x EVM address');
    }
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('chainId must be a positive integer');
    }
    if (!Array.isArray(abi) || abi.length === 0) {
      throw new BadRequestException('abi must be a non-empty array');
    }

    const abiJson = JSON.stringify(abi);
    const abiHash = createHash('sha256').update(abiJson).digest('hex');

    const existing = await this.repo.findOne({
      where: { contractAddress, chainId, deployedAtBlock },
    });

    if (existing) {
      if (existing.abiHash !== abiHash) {
        this.logger.warn(
          `ABI drift detected for ${contractAddress} chainId=${chainId} block=${deployedAtBlock}: ` +
            `existing=${existing.abiHash} incoming=${abiHash}`,
        );
        existing.abiJson = abiJson;
        existing.abiHash = abiHash;
        existing.version = version;
        return this.repo.save(existing);
      }
      return existing;
    }

    const entry = this.repo.create({
      contractAddress,
      chainId,
      deployedAtBlock,
      version,
      abiJson,
      abiHash,
    });
    const saved = await this.repo.save(entry);
    this.logger.log(
      `Registered ABI ${version} for ${contractAddress} chainId=${chainId} from block ${deployedAtBlock}`,
    );
    return saved;
  }

  /**
   * Resolve the ABI that was canonical at `atBlock` for this contract.
   * Selects the entry with the greatest deployedAtBlock <= atBlock.
   * Throws NotFoundException (fail-closed) if no matching version exists.
   */
  async resolveAbi(
    contractAddress: string,
    chainId: number,
    atBlock: number,
  ): Promise<object[]> {
    const entry = await this.repo.findOne({
      where: {
        contractAddress,
        chainId,
        deployedAtBlock: LessThanOrEqual(atBlock),
      },
      order: { deployedAtBlock: 'DESC' },
    });

    if (!entry) {
      throw new NotFoundException(
        `No ABI registered for ${contractAddress} chainId=${chainId} at block ${atBlock}`,
      );
    }

    return JSON.parse(entry.abiJson) as object[];
  }

  /** List all registered versions for a contract, ordered oldest-first. */
  async listVersions(
    contractAddress: string,
    chainId: number,
  ): Promise<AbiVersionRegistry[]> {
    return this.repo.find({
      where: { contractAddress, chainId },
      order: { deployedAtBlock: 'ASC' },
    });
  }
}