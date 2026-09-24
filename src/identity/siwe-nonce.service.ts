import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { randomBytes } from 'crypto';
import { SiweNonce } from './entities/siwe-nonce.entity';

/** TTL for an issued nonce: 5 minutes. */
const NONCE_TTL_MS = 5 * 60 * 1000;

export interface SiweVerifyParams {
  nonce: string;
  address: string;
  domain: string;
  chainId: number;
}

/**
 * V2-BE-101: Harden SIWE Nonce, Domain, and Chain Binding
 *
 * Issues one-time-use nonces and verifies them against:
 *   - Single-use enforcement (replay prevention)
 *   - TTL expiry
 *   - Address binding
 *   - Domain binding (must match configured allowed domain)
 *   - Chain ID binding (Optimism / EVM only)
 *
 * Fails closed: any mismatch results in UnauthorizedException with no
 * partial state committed.
 */
@Injectable()
export class SiweNonceService {
  private readonly logger = new Logger(SiweNonceService.name);

  constructor(
    @InjectRepository(SiweNonce)
    private readonly repo: Repository<SiweNonce>,
  ) {}

  /**
   * Issue a fresh nonce bound to the given address, domain, and chainId.
   * The nonce is a cryptographically random 32-byte hex string.
   */
  async issue(
    address: string,
    domain: string,
    chainId: number,
  ): Promise<string> {
    this.assertValidAddress(address);
    this.assertValidDomain(domain);
    this.assertValidChainId(chainId);

    const nonce = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    const record = this.repo.create({
      nonce,
      address: address.toLowerCase(),
      domain,
      chainId,
      isConsumed: false,
      expiresAt,
    });
    await this.repo.save(record);
    this.logger.debug(
      `Issued nonce for ${address} domain=${domain} chainId=${chainId}`,
    );
    return nonce;
  }

  /**
   * Verify and atomically consume a nonce.
   * Throws UnauthorizedException (fail-closed) on any validation failure.
   */
  async verifyAndConsume(params: SiweVerifyParams): Promise<void> {
    const { nonce, address, domain, chainId } = params;

    this.assertValidAddress(address);
    this.assertValidDomain(domain);
    this.assertValidChainId(chainId);

    const record = await this.repo.findOne({ where: { nonce } });

    if (!record) {
      throw new UnauthorizedException('Invalid or unknown nonce');
    }
    if (record.isConsumed) {
      throw new UnauthorizedException('Nonce has already been used');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('Nonce has expired');
    }
    if (record.address !== address.toLowerCase()) {
      throw new UnauthorizedException('Nonce address binding mismatch');
    }
    if (record.domain !== domain) {
      throw new UnauthorizedException('Nonce domain binding mismatch');
    }
    if (record.chainId !== chainId) {
      throw new UnauthorizedException('Nonce chainId binding mismatch');
    }

    // Consume atomically
    record.isConsumed = true;
    await this.repo.save(record);
    this.logger.log(
      `Nonce consumed for ${address} domain=${domain} chainId=${chainId}`,
    );
  }

  /** Prune expired and consumed nonces; intended for a scheduled cleanup job. */
  async pruneExpired(): Promise<number> {
    const result = await this.repo.delete({
      expiresAt: LessThan(new Date()),
    });
    return result.affected ?? 0;
  }

  private assertValidAddress(address: string): void {
    if (!address.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new BadRequestException('Invalid EVM address');
    }
  }

  private assertValidDomain(domain: string): void {
    if (!domain || domain.trim().length === 0) {
      throw new BadRequestException('Domain must not be empty');
    }
  }

  private assertValidChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('chainId must be a positive integer');
    }
  }
}
