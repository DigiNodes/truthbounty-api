import { BadRequestException, Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { verifyMessage } from 'ethers';

@Injectable()
export class IdentityService {
  constructor(private prisma: PrismaService) {}

  async createUser() {
    return this.prisma.user.create({
      data: {},
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { wallets: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async linkWallet(userId: string, dto: LinkWalletDto) {
    const { address, chain, signature, message } = dto;

    // 1. Verify Signature
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      throw new BadRequestException('Invalid signature format');
    }

    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      throw new BadRequestException('Signature verification failed. Address mismatch.');
    }

    // 2. Check if wallet is already linked
    // We check if this address is linked on ANY chain to ANY user?
    // "No wallet mapped to multiple users".
    // "Prevent wallet reuse across users".
    // If 0x123 is linked to User A on ETH, can User B link 0x123 on POLYGON?
    // No, because 0x123 is the same identity key.
    // So we should check if `address` exists in DB for a different userId.
    
    const existingWallet = await this.prisma.wallet.findFirst({
      where: {
        address: address, // Check global uniqueness of address ownership
      },
    });

    if (existingWallet) {
      if (existingWallet.userId !== userId) {
        throw new ConflictException('Wallet is already linked to another user.');
      }
      // If linked to same user, check chain
      // If exact match (address + chain), it's already done.
      if (existingWallet.chain === chain) {
         return existingWallet; // Already linked
      }
      // Same user, different chain.
      // We allow this.
    }

    // 3. Check if exact (address, chain) tuple exists (should be covered by above logic mostly, but let's be safe)
    // The @unique([address, chain]) in schema will throw if we try to create duplicate.

    // 4. Link it
    // Ensure user exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.wallet.create({
      data: {
        address,
        chain,
        userId,
      },
    });
  }

  async unlinkWallet(userId: string, address: string, chain: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: {
        address_chain: {
          address,
          chain,
        },
      },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (wallet.userId !== userId) {
      throw new BadRequestException('Wallet does not belong to this user');
    }

    // Safeguard: Maybe check if it's the last wallet?
    // "Support unlinking with safeguards"
    // Let's count wallets.
    const count = await this.prisma.wallet.count({
      where: { userId },
    });

    // If we enforce at least one wallet:
    // if (count <= 1) throw new BadRequestException('Cannot unlink the last wallet.');
    // For now, I'll allow unlinking all, as the user might want to delete their identity or switch completely.
    // But I'll leave a comment.

    return this.prisma.wallet.delete({
      where: {
        address_chain: {
          address,
          chain,
        },
      },
    });
  }

  async findUserByAddress(address: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { address },
      include: { user: true },
    });
    return wallet?.user || null;
  }
}
