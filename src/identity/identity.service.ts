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
import { Prisma, User, Wallet } from '../generated/client/client';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';

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

const MIN_WALLETS = 1;

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  // ─── User ──────────────────────────────────────────────────────────────

  /**
   * Create a new user with no initial wallets.
   * The caller is responsible for linking at least one wallet afterward.
   */
  async createUser(): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { walletAddress: 'temp-' + Date.now().toString() } });
      await tx.sybilScore.create({ data: { userId: user.id } });
      this.logger.log(`User created: ${user.id}`);
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

  async linkWallet(userId: string, dto: LinkWalletDto): Promise<LinkWalletResult> {
    const { address, chain, signature, message } = dto;
    const normalizedAddress = this.normalizeAddress(address);
    this.verifySignature(message, signature, normalizedAddress);

    return this.prisma.$transaction(async (tx) => {
      const existingWallet = await tx.wallet.findFirst({ where: { address: normalizedAddress } });

      if (existingWallet) {
        if (existingWallet.userId !== userId) {
          throw new ConflictException(
            `Address ${normalizedAddress} is already linked to another account`,
          );
        }
        if (existingWallet.chain === chain) {
          this.logger.debug(`Wallet ${normalizedAddress}/${chain} already linked to user ${userId} — no-op`);
          return { wallet: existingWallet, alreadyLinked: true };
        }
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException(`User ${userId} not found`);

      const wallet = await tx.wallet.create({
        data: { address: normalizedAddress, chain, userId },
      });

      this.logger.log(`Wallet ${normalizedAddress} (${chain}) linked to user ${userId}`);
      return { wallet, alreadyLinked: false };
    });
  }

  async unlinkWallet(userId: string, address: string, chain: string): Promise<Wallet> {
    const normalizedAddress = this.normalizeAddress(address);
    const wallet = await this.prisma.wallet.findUnique({
      where: { address_chain: { address: normalizedAddress, chain } },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${normalizedAddress} on chain ${chain} not found`);
    }
    if (wallet.userId !== userId) {
      throw new ForbiddenException(`Wallet ${normalizedAddress} does not belong to user ${userId}`);
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
    });

    await this.auditTrailService.log({
      actionType: AuditActionType.WALLET_UNLINKED,
      entityType: AuditEntityType.WALLET,
      entityId: deleted.id,
      userId,
      walletAddress: normalizedAddress,
      description: 'Wallet unlinked',
    });

    this.logger.log(`Wallet ${normalizedAddress} (${chain}) unlinked from user ${userId}`);
    return deleted;
  }

  async findUserByAddress(address: string): Promise<User | null> {
    const normalized = this.normalizeAddress(address);
    const wallet = await this.prisma.wallet.findFirst({
      where: { address: normalized },
      include: { user: true },
    });
    return wallet?.user ?? null;
  }

  async getWalletsForUser(userId: string, chain?: string): Promise<Wallet[]> {
    await this.findUserOrThrow(userId);
    return this.prisma.wallet.findMany({
      where: { userId, ...(chain ? { chain } : {}) },
      orderBy: { linkedAt: 'asc' },
    });
  }

  private normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch {
      throw new BadRequestException(`Invalid EVM address: "${address}"`);
    }
  }

  private verifySignature(message: string, signature: string, expectedAddress: string): void {
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      throw new BadRequestException('Signature could not be parsed — ensure it is a valid EIP-191 hex signature');
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
      (err as Prisma.PrismaClientKnownRequestError).code === 'P2002'
    );
  }
}
