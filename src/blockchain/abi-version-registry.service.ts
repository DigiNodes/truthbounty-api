import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { createHash } from 'crypto';
import { getAddress } from 'ethers';
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
 * - Addresses are stored in one canonical (EIP-55 checksummed) form, so the
 *   uniqueness and lookup comparisons are not casing-dependent.
 * - ABI drift is detected via SHA-256 hash comparison on registration and is
 *   rejected; the canonical ABI for a block range is never rewritten.
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
    const { chainId, version, abi } = dto;
    const contractAddress = this.normalizeAddress(dto.contractAddress);
    const deployedAtBlock = this.assertValidBlock(
      dto.deployedAtBlock,
      'deployedAtBlock',
    );

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
        // Fail closed. Overwriting in place would silently change the canonical
        // ABI for a historical block range, so events decoded before the change
        // and events re-decoded after it would disagree. A genuine correction
        // has to be an explicit, auditable operation, and there isn't one here.
        this.logger.error(
          `ABI drift detected for ${contractAddress} chainId=${chainId} block=${deployedAtBlock}: ` +
            `existing=${existing.abiHash} incoming=${abiHash}`,
        );
        throw new ConflictException(
          `ABI drift detected for ${contractAddress} chainId=${chainId} block=${deployedAtBlock}`,
        );
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
    const normalizedAddress = this.normalizeAddress(contractAddress);
    const block = this.assertValidBlock(atBlock, 'atBlock');

    const entry = await this.repo.findOne({
      where: {
        contractAddress: normalizedAddress,
        chainId,
        deployedAtBlock: LessThanOrEqual(block),
      },
      order: { deployedAtBlock: 'DESC' },
    });

    if (!entry) {
      throw new NotFoundException(
        `No ABI registered for ${normalizedAddress} chainId=${chainId} at block ${block}`,
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
      where: {
        contractAddress: this.normalizeAddress(contractAddress),
        chainId,
      },
      order: { deployedAtBlock: 'ASC' },
    });
  }

  /**
   * Canonicalise an EVM address to its EIP-55 checksummed form.
   *
   * (contractAddress, chainId, deployedAtBlock) is compared as a unique string
   * triple, so the same deployment registered once lowercase and once
   * checksummed would create two rows holding different ABIs, and the ABI that
   * resolution returns would depend on the casing the caller happened to use.
   * getAddress also rejects input that is not a valid address.
   */
  private normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch {
      throw new BadRequestException(
        'contractAddress must be a valid EVM address',
      );
    }
  }

  /**
   * Block numbers are non-negative safe integers. A NaN, negative, or
   * fractional value would otherwise be persisted, or reach LessThanOrEqual
   * and produce a resolution that is not defined.
   */
  private assertValidBlock(value: number, field: string): number {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return value;
  }
}
