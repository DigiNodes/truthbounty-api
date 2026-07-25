import {
  BadRequestException,
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { verifyMessage, getAddress } from 'ethers';
import { Prisma, User, Wallet } from '@prisma/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserWithWallets = User & { wallets: Wallet[] };

export interface WalletIdentifier {
  address: string;
  chain: string;
}

export interface LinkWalletResult {
  wallet: Wallet;
  alreadyLinked: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum number of wallets a user must retain. Set to 0 to allow full unlink. */
const MIN_WALLETS = 1;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── User ──────────────────────────────────────────────────────────────

  /**
   * Create a new user with no initial wallets.
   * The caller is responsible for linking at least one wallet afterward.
   */
  async createUser(): Promise<User> {
    const user = await this.prisma.user.create({ data: {} });
    this.logger.log(`User created: ${user.id}`);
    return user;
import { verifyMessage } from 'ethers';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';

@Injectable()
export class IdentityService {
  constructor(
    private prisma: PrismaService,
    private auditTrailService: AuditTrailService,
  ) {}

  async createUser() {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {},
      });

      await tx.sybilScore.create({
        data: {
          userId: user.id,
        },
      });

      return user;
    });
  }

  /**
   * Fetch a user by ID, including their linked wallets.
   * Throws `NotFoundException` if no user exists with that ID.
   */
  async getUser(id: string): Promise<UserWithWallets> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { wallets: true },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  // ─── Link wallet ───────────────────────────────────────────────────────

  /**
   * Link an EVM wallet to a user after verifying the provided signature.
   *
   * Rules enforced:
   * - The signature must recover to the claimed address (EIP-191).
   * - An address may not be linked to more than one user (cross-chain included).
   * - The (address, chain) pair must be unique per the schema constraint.
   * - Returns `alreadyLinked: true` when the exact pair is already on this user
   *   so the caller can distinguish a no-op from a new link.
   *
   * @throws BadRequestException   on signature format/mismatch errors.
   * @throws ConflictException     when the address belongs to a different user.
   * @throws NotFoundException     when the user does not exist.
   */
  async linkWallet(
    userId: string,
    dto: LinkWalletDto,
  ): Promise<LinkWalletResult> {
    const { address, chain, signature, message } = dto;

    // ── 1. Normalise and verify signature ──────────────────────────────
    const normalizedAddress = this.normalizeAddress(address);
    this.verifySignature(message, signature, normalizedAddress);

    // ── 2. Check global address ownership ─────────────────────────────
    const existingWallet = await this.prisma.wallet.findFirst({
      where: { address: normalizedAddress },
    });

    if (existingWallet) {
      if (existingWallet.userId !== userId) {
        throw new ConflictException(
          `Address ${normalizedAddress} is already linked to another account`,
        );
      }
      // Same user + same chain → idempotent no-op
      if (existingWallet.chain === chain) {
        this.logger.debug(
          `Wallet ${normalizedAddress}/${chain} already linked to user ${userId} — no-op`,
        );
        return { wallet: existingWallet, alreadyLinked: true };
      }
      // Same user, different chain → fall through to create
    }

    // ── 3. Ensure user exists before writing ───────────────────────────
    await this.findUserOrThrow(userId);

    // ── 4. Create wallet — handle schema-level unique violation ────────
    try {
      const wallet = await this.prisma.wallet.create({
        data: { address: normalizedAddress, chain, userId },
      });
      this.logger.log(
        `Wallet ${normalizedAddress} (${chain}) linked to user ${userId}`,
      );
      return { wallet, alreadyLinked: false };
    } catch (err) {
      if (this.isPrismaUniqueViolation(err)) {
        throw new ConflictException(
          `Wallet ${normalizedAddress} on chain ${chain} is already linked`,
        );
      }
      throw err;
    }
    // 1. Verify Signature (outside transaction - pure computation)
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      throw new BadRequestException('Invalid signature format');
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      throw new BadRequestException('Signature verification failed. Address mismatch.');
    }

    // 2-4. Transactional check-and-create to prevent race conditions
    return this.prisma.$transaction(async (tx) => {
      // Check if wallet is already linked
      const existingWallet = await tx.wallet.findFirst({
        where: {
          address: address,
        },
      });

      if (existingWallet) {
        if (existingWallet.userId !== userId) {
          throw new ConflictException('Wallet is already linked to another user.');
        }
        if (existingWallet.chain === chain) {
           return existingWallet;
        }
      }

      // Ensure user exists
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      return tx.wallet.create({
        data: {
          address,
          chain,
          userId,
        },
      });
    });
  }

  // ─── Unlink wallet ─────────────────────────────────────────────────────

  /**
   * Remove a wallet from a user's account.
   *
   * Enforces `MIN_WALLETS`: if the user would drop below the minimum number
   * of linked wallets, the request is rejected. Set `MIN_WALLETS = 0` to
   * allow full unlinking.
   *
   * @throws NotFoundException   if the wallet does not exist.
   * @throws ForbiddenException  if the wallet belongs to a different user.
   * @throws BadRequestException if unlinking would violate the minimum wallet count.
   */
  async unlinkWallet(
    userId: string,
    identifier: WalletIdentifier,
  ): Promise<Wallet> {
    const { address, chain } = identifier;
    const normalizedAddress = this.normalizeAddress(address);

    const wallet = await this.prisma.wallet.findUnique({
      where: { address_chain: { address: normalizedAddress, chain } },
    });

    if (!wallet) {
      throw new NotFoundException(
        `Wallet ${normalizedAddress} on chain ${chain} not found`,
      );
    }

    if (wallet.userId !== userId) {
      throw new ForbiddenException(
        `Wallet ${normalizedAddress} does not belong to user ${userId}`,
      );
    }

    if (MIN_WALLETS > 0) {
      const count = await this.prisma.wallet.count({ where: { userId } });
      if (count <= MIN_WALLETS) {
        throw new BadRequestException(
          `Cannot unlink wallet — users must retain at least ${MIN_WALLETS} linked wallet(s)`,
        );
      }
    }

    const deleted = await this.prisma.wallet.delete({
      where: { address_chain: { address: normalizedAddress, chain } },
    // if (count <= 1) throw new BadRequestException('Cannot unlink the last wallet.');
    // For now, I'll allow unlinking all, as the user might want to delete their identity or switch completely.
    // But I'll leave a comment.

    // Log audit entry for wallet unlink
    await this.auditTrailService.log({
      actionType: AuditActionType.WALLET_UNLINKED,
      entityType: AuditEntityType.WALLET,
      entityId: wallet.id,
      userId: userId,
      walletAddress: address,
      description: 'Wallet unlinked',
    });
    return this.prisma.wallet.delete({
      where: {
        address_chain: {
          address,
          chain,
        },
      },
    });

    this.logger.log(
      `Wallet ${normalizedAddress} (${chain}) unlinked from user ${userId}`,
    );
    return deleted;
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * Look up the user who owns a given wallet address (any chain).
   * Returns `null` when no wallet with that address is found.
   */
  async findUserByAddress(address: string): Promise<User | null> {
    const normalized = this.normalizeAddress(address);
    const wallet = await this.prisma.wallet.findFirst({
      where: { address: normalized },
      include: { user: true },
    });
    return wallet?.user ?? null;
  }

  /**
   * Return all wallets linked to a user, optionally filtered by chain.
   */
  async getWalletsForUser(userId: string, chain?: string): Promise<Wallet[]> {
    await this.findUserOrThrow(userId);
    return this.prisma.wallet.findMany({
      where: { userId, ...(chain ? { chain } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  /**
   * Normalise an EVM address to EIP-55 checksum form.
   * Throws `BadRequestException` on malformed input.
   */
  private normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch {
      throw new BadRequestException(
        `Invalid EVM address: "${address}"`,
      );
    }
  }

  /**
   * Recover the signer from an EIP-191 signed message and assert it matches
   * the claimed address.
   */
  private verifySignature(
    message: string,
    signature: string,
    expectedAddress: string,
  ): void {
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw new BadRequestException(
        'Signature could not be parsed — ensure it is a valid EIP-191 hex signature',
      );
    }

    if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new BadRequestException(
        `Signature verification failed: recovered ${recovered}, expected ${expectedAddress}`,
      );
    }
  }

  private async findUserOrThrow(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    return user;
  }

  private isPrismaUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}