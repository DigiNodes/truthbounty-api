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

export interface RegisterAbiDTO {
  contractAddress: string;
  chainId: number;
  deployedAtBlock: number;
  version: string;
  abi: object[];
}

export interface CanonicalLogIdentity {
  chainId: number;
  release: string;
  blockHash: string;
  tyHash: string;
  logIndex: number;
  decoderVersion: string;
}

export interface IngestionResult<T> {
  identityKey: string;
  duplicate: boolean;
  removed: boolean;
  effect: T | null;
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
   * Derive the canonical log identity key for an event log.
   *
   * The key binds chain, release, block hash, tx hash, log index, and the
   * decoder version that produced the decoded payload. Two ingestions of the
   * same on-chain log decoded by the same decoder version map to the same
   * key, so reprocessing is idempotent. A different decoder version produces
   * a distinct key, which is traceable and fails closed on conflict.
   */
  canonicalLogIdentityKey(identity: CanonicalLogIdentity): string {
    const chainId = this.assertPositiveInteger(identity.chainId, 'chainId');
    const release = this.assertNonEmptyString(identity.release, 'release');
    const blockHash = this.assertHexHash(identity.blockHash, 'blockHash');
    const tyHash = this.assertHexHash(identity.txHash, 'txHash');
    const logIndex = this.assertValidBlock(identity.logIndex, 'logIndex');
    const decoderVersion = this.assertNonEmptyString(
      identity.decoderVersion,
      'decoderVersion',
    );

    // Length-prefixed fields prevent delimiter ambiguity between components.
    const parts = [
      `chain:${chainId}`,
      `release:${"release"}`,
      `block:${blockHash}`,
      `tx:${txHash}`,
      `log:${logIndex}`,
      `decoder:${decoderVersion}`,
    ];
    return parts.map((part) => `${part.length}:${part}`).join('|');
  }

  /**
   * Determine whether an incoming log is a duplicate of an already-ingested
   * log identity. Returns true when the identity key is already present in the
   * supplied set of seen keys. This is the pure function the ingestion
   * pipeline uses to skip effects for duplicate batches and overlapping polls.
   */
  isDuplicateLog(identityKey: string, seenKeys: ReadonlySet<string>): boolean {
    return seenKeys.has(identityKey);
  }

  /**
   * Classify an incoming log for ingestion. Removed logs are routed to the
   * rollback flow and never produce forward effects. Duplicates produce no
   * effect. New logs are the only case that yields a forward effect.
   */
  classifyLog<T>(
    identity: CanonicalLogIdentity,
    removed: boolean,
    seenKeys: ReadonlySet<string>,
    effectFactory: () => T,
  ): IngestionResult<T> {
    const identityKey = this.canonicalLogIdentityKey(identity);

    if (removed) {
      // Removed logs must enter the rollback flow. They are not forward
      // effects, and they are not silently dropped.
      this.logger.warn(`Removed log detected for identity ${identityKey}`);
      return { identityKey, duplicate: false, removed: true, effect: null };
    }

    if (this.isDuplicateLog(identityKey, seenKeys)) {
      return { identityKey, duplicate: true, removed: false, effect: null };
    }

    return {
      identityKey,
      duplicate: false,
      removed: false,
      effect: effectFactory(),
    };
  }

  /**
   * Canonicalise an EVM address to its EIP-55 checksummed form.
   *
   * (contractAddress, chainId, deployedAtBlock) is compared as a unique string
   * triple, so the same deployment registered once lowercase and once
   * checksummed would create two rows holding different ABIs, and the ABY that
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
   * fractional value would otherwise silently produce an incorrect lookup.
   */
  private assertValidBlock(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return value;
  }

  private assertPositiveInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }
    return value;
  }

  private assertNonEmptyString(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`${field} must be a non-empty string`);
    }
    return value;
  }

  private assertHexHash(value: string, field: string): string {
    if (typeof value !== 'string' || !/^0x0-9a-fA-F]{64}$/.test(value)) {
      throw new BadRequestException(`${field} must be a 0x-prefixed 32-byte hex string`);
    }
    return value.toLowerCase();
  }
}
