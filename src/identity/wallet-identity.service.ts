import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletIdentity } from './entities/wallet-identity.entity';

/**
 * V2-BE-103: Enforce Wallet-to-User Identity Integrity
 *
 * Guarantees one wallet address (per chain) belongs to exactly one user:
 *
 * - bind: idempotent for the existing owner, ConflictException for anyone else.
 *   The unique index is the backstop, so a race resolves to a conflict rather
 *   than a duplicate binding.
 * - resolveUser: the only sanctioned way to go from wallet to user identity.
 * - assertOwnership: fail-closed check for callers that act on behalf of a
 *   wallet — an unbound wallet is a 404, someone else's wallet is a 403.
 * - unbind: only the owning user may release a wallet.
 *
 * Nothing here can reassign an existing binding. Moving a wallet between users
 * would be an explicit, auditable operation, and there isn't one.
 */

export interface BindResult {
  identity: WalletIdentity;
  /** True when this wallet was already bound to the same user. */
  alreadyBound: boolean;
}

@Injectable()
export class WalletIdentityService {
  private readonly logger = new Logger(WalletIdentityService.name);

  constructor(
    @InjectRepository(WalletIdentity)
    private readonly repo: Repository<WalletIdentity>,
  ) {}

  /**
   * Bind a wallet to a user. Safe to call twice: the second call for the same
   * user is a no-op, and a call for a different user is rejected.
   */
  async bind(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<BindResult> {
    this.assertValidUserId(userId);
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const normalized = walletAddress.toLowerCase();
    const existing = await this.repo.findOne({
      where: { walletAddress: normalized, chainId },
    });

    if (existing) {
      if (existing.userId !== userId) {
        // Fail closed — never silently move a wallet to a second identity.
        throw new ConflictException(
          `Wallet ${normalized} on chain ${chainId} is already bound to another user`,
        );
      }
      this.logger.debug(
        `Wallet ${normalized}/${chainId} already bound to user ${userId} — no-op`,
      );
      return { identity: existing, alreadyBound: true };
    }

    try {
      const saved = await this.repo.save(
        this.repo.create({ userId, walletAddress: normalized, chainId }),
      );
      this.logger.log(
        `Wallet ${normalized} (chainId=${chainId}) bound to user ${userId}`,
      );
      return { identity: saved, alreadyBound: false };
    } catch (error) {
      // A concurrent bind won the race and the unique index caught ours.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `Wallet ${normalized} on chain ${chainId} was bound by a concurrent request`,
        );
      }
      throw error;
    }
  }

  /** The user identity that owns this wallet, or null when nothing is bound. */
  async resolveUser(
    walletAddress: string,
    chainId: number,
  ): Promise<string | null> {
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const identity = await this.repo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), chainId },
    });

    return identity?.userId ?? null;
  }

  /**
   * Confirm a wallet belongs to this user before acting on their behalf.
   * Throws for an unbound wallet and for someone else's wallet alike.
   */
  async assertOwnership(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidUserId(userId);

    const identity = await this.findOneOrThrow(walletAddress, chainId);

    if (identity.userId !== userId) {
      throw new ForbiddenException(
        `Wallet ${identity.walletAddress} is bound to a different user`,
      );
    }

    return identity;
  }

  /** Every wallet bound to a user, oldest first. */
  async listForUser(userId: string): Promise<WalletIdentity[]> {
    this.assertValidUserId(userId);

    return this.repo.find({ where: { userId }, order: { createdAt: 'asc' } });
  }

  /** Release a wallet. Only the owning user may do this. */
  async unbind(
    userId: string,
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidUserId(userId);

    const identity = await this.findOneOrThrow(walletAddress, chainId);

    if (identity.userId !== userId) {
      throw new ForbiddenException(
        `Wallet ${identity.walletAddress} is bound to a different user`,
      );
    }

    await this.repo.remove(identity);
    this.logger.log(
      `Wallet ${identity.walletAddress} (chainId=${chainId}) unbound from user ${userId}`,
    );

    return identity;
  }

  private async findOneOrThrow(
    walletAddress: string,
    chainId: number,
  ): Promise<WalletIdentity> {
    this.assertValidAddress(walletAddress);
    this.assertValidChainId(chainId);

    const normalized = walletAddress.toLowerCase();
    const identity = await this.repo.findOne({
      where: { walletAddress: normalized, chainId },
    });

    if (!identity) {
      throw new NotFoundException(
        `Wallet ${normalized} on chain ${chainId} is not bound to any user`,
      );
    }

    return identity;
  }

  private assertValidUserId(userId: string): void {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new BadRequestException('userId must be a non-empty string');
    }
  }

  private assertValidAddress(address: string): void {
    if (typeof address !== 'string' || !address.match(/^0x[0-9a-fA-F]{40}$/)) {
      throw new BadRequestException('Invalid EVM wallet address');
    }
  }

  private assertValidChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('chainId must be a positive integer');
    }
  }

  /** Postgres, SQLite and MySQL each report a unique violation their own way. */
  private isUniqueViolation(error: unknown): boolean {
    const candidate = error as {
      code?: string;
      driverError?: { code?: string };
    };
    const code = candidate?.driverError?.code ?? candidate?.code;

    return (
      code === '23505' ||
      code === 'SQLITE_CONSTRAINT' ||
      code === 'ER_DUP_ENTRY'
    );
  }
}
