import { Injectable, BadRequestException, UnauthorizedException, InternalServerErrorException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verifyMessage } from 'ethers';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AuthService {
  private readonly NONCE_TTL_SECONDS = 5 * 60; // 5 minutes

  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
  ) {}

  /**
   * Generate a nonce challenge for a wallet address
   */
  async generateChallenge(address: string): Promise<string> {
    const nonce = this.generateRandomNonce();
    // Persist nonce to Redis with TTL to allow scaling across instances
    const key = `auth:nonce:${address.toLowerCase()}`;

    try {
      const ok = await this.redisService.set(key, nonce, this.NONCE_TTL_SECONDS);
      if (!ok) {
        this.logger.error(`Failed to persist nonce for ${address}`);
        throw new InternalServerErrorException('Failed to generate challenge. Please try again later.');
      }
    } catch (err) {
      this.logger.error(`Error persisting nonce for ${address}: ${err?.message ?? err}`);
      throw new InternalServerErrorException('Failed to generate challenge. Please try again later.');
    }

    return `Sign in to TruthBounty: ${nonce}`;
  }

  /**
   * Verify wallet signature and issue JWT token
   */
  async login(loginDto: LoginDto): Promise<{ accessToken: string; user: any }> {
    const { address, signature, message } = loginDto;

    // 1. Verify the signature
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch (error) {
      throw new BadRequestException('Invalid signature format');
    }

    // 2. Check if recovered address matches the claimed address
    if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
      throw new UnauthorizedException('Signature verification failed. Address mismatch.');
    }

    // 3. Verify the message contains a valid nonce
    const key = `auth:nonce:${address.toLowerCase()}`;
    const stored = await this.redisService.get(key);
    if (!stored) {
      throw new UnauthorizedException('No challenge found or challenge expired. Please request a challenge first.');
    }

    const expectedMessage = `Sign in to TruthBounty: ${stored}`;

    // Compare the full challenge message in constant time to avoid timing attacks.
    if (!this.constantTimeEquals(message, expectedMessage)) {
      throw new UnauthorizedException('Invalid nonce in message.');
    }

    // Delete used nonce (prevent replay attacks)
    await this.redisService.del(key).catch(() => null);

    // 7. Find or create user
    let user = await this.prisma.wallet.findFirst({
      where: { address: address.toLowerCase() },
      include: { user: true },
    });

    // If wallet doesn't exist, we can still allow login but user won't have full access
    // until they link their wallet properly
    const userId = user?.user?.id || null;

    // 8. Generate JWT token
    // Align 'sub' with RFC 7519: prefer stable unique subject (userId) when available
    const subject = userId ? String(userId) : address.toLowerCase();
    const payload = {
      address: address.toLowerCase(),
      userId,
      sub: subject,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: userId,
        address: address.toLowerCase(),
      },
    };
  }

  /**
   * Validate JWT token and return user info
   */
  async validateToken(payload: any): Promise<any> {
    let { address, userId } = payload;

    // If sub contains an address (0x...), prefer it for the wallet lookup
    const sub = payload.sub;
    const candidateAddress =
      address || (typeof sub === 'string' && sub.startsWith('0x') ? sub : undefined);

    // Verify wallet still exists using the best available address
    const wallet = candidateAddress
      ? await this.prisma.wallet.findFirst({
          where: { address: candidateAddress },
          include: { user: true },
        })
      : null;

    return {
      address: wallet?.address || address,
      userId: wallet?.user?.id || userId,
      user: wallet?.user || null,
    };
  }

  /**
   * Generate a random nonce
   */
  private generateRandomNonce(): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const length = 32;
    let nonce = '';

    // Use crypto for secure random generation
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(length);

    for (let i = 0; i < length; i++) {
      nonce += characters[bytes[i] % characters.length];
    }

    return nonce;
  }

  /**
   * Constant-time string comparison for challenge messages.
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a, 'utf8');
    const bBuffer = Buffer.from(b, 'utf8');

    if (aBuffer.length !== bBuffer.length) {
      return false;
    }

    return timingSafeEqual(aBuffer, bBuffer);
  }
}
