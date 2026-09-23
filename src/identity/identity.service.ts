import {
  BadRequestException,
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { verifyMessage, getAddress } from 'ethers';
import { Prisma, User, Wallet } from '@prisma/client';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';
import {
  constantTimeAddressEqual,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';

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

  async createUser(): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: {} });
      await tx.sybilScore.create({ data: { userId: user.id } });
      this.logger.log(`User created: ${user.id}`);
      return user;
    });
  }

  async getUser(id: string): Promise<UserWithWallets> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { wallets: true },
    });
    // Redacted: never echo the requested id back (enumeration-safe,
    // constant-shape with other lookup failures).
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async linkWallet(userId: string, dto: LinkWalletDto): Promise<LinkWalletResult> {
    const { address, chain, signature, message } = dto;
    const normalizedAddress = this.normalizeAddress(address);
    this.verifySignature(message, signature, normalizedAddress);

    return this.prisma.$transaction(async (tx) => {
      const existingWallet = await tx.wallet.findFirst({ where: { address: normalizedAddress } });

      if (existingWallet) {
        if (!constantTimeAddressEqual(existingWallet.userId, userId)) {
          // Redacted: do not disclose the address or the owning account.
          // Same exception type preserved (Conflict) for REST semantics,
          // but message is constant-shape.
          this.logger.warn('Wallet link failed [already-linked]');
          // Dummy compare to normalize timing between hit/miss branches.
          timingSafeEqualUtf8(existingWallet.chain, chain);
          throw new ConflictException('Wallet linkage failed');
        }
        if (timingSafeEqualUtf8(existingWallet.chain, chain)) {
          this.logger.debug(`Wallet link no-op — already linked`);
          return { wallet: existingWallet, alreadyLinked: true };
        }
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      // Redacted: same generic message as already-linked so callers cannot
      // distinguish "user missing" from "wallet taken" via message content.
      if (!user) throw new NotFoundException('Wallet linkage failed');

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

    // Constant-shape: not-found and not-owned collapse to the same
    // NotFound + generic message so ownership cannot be enumerated.
    // Timing-safe user comparison (no short-circuit !== oracle).
    if (!wallet || !constantTimeAddressEqual(wallet.userId, userId)) {
      this.logger.warn('Wallet unlink failed [not-found-or-forbidden]');
      throw new NotFoundException('Wallet unlink failed');
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
      orderBy: { createdAt: 'asc' },
    });
  }

  private normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch {
      // Redacted: do not echo attacker-supplied input.
      throw new BadRequestException('Invalid EVM address');
    }
  }

  private verifySignature(message: string, signature: string, expectedAddress: string): void {
    let recovered: string;
    try {
      recovered = verifyMessage(message, signature);
    } catch {
      // Constant-shape with address-mismatch below; logged server-side only.
      this.logger.warn('Wallet signature parse failed');
      timingSafeEqualUtf8(message, message);
      throw new BadRequestException('Invalid credentials');
    }

    if (!constantTimeAddressEqual(recovered, expectedAddress)) {
      // Redacted: never echo recovered/expected addresses (previously leaked both).
      this.logger.warn('Wallet signature verification failed');
      throw new BadRequestException('Invalid credentials');
    }
  }

  private async findUserOrThrow(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private isPrismaUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}
