import { Injectable, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { PrismaService } from '../../prisma/prisma.service';
import { SybilResistanceService } from '../../sybil-resistance/sybil-resistance.service';

export interface VerifyWorldcoinProofDto {
  proof: {
    merkle_root: string;
    nullifier_hash: string;
    proof: string;
    verification_level: string;
  };
  action: string;
  signal?: string;
}

interface WorldcoinCloudVerifyResponse {
  success?: boolean;
}

@Injectable()
export class WorldcoinService {
  private readonly logger = new Logger(WorldcoinService.name);

  constructor(
    @InjectRepository(WorldIdVerification)
    private readonly worldIdVerificationRepository: Repository<WorldIdVerification>,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sybilResistanceService: SybilResistanceService,
  ) {}

  async verifyProof(userId: string, verifyDto: VerifyWorldcoinProofDto): Promise<WorldIdVerification> {
    const { proof, action, signal } = verifyDto;

    // Verify the proof with Worldcoin
    const isValid = await this.verifyWorldcoinProof(proof, action, signal);
    
    if (!isValid) {
      throw new BadRequestException('Invalid Worldcoin proof');
    }

    // Check if nullifier hash has already been used (prevent duplicate verification)
    const existingVerificationTypeORM = await this.worldIdVerificationRepository.findOne({
      where: { nullifierHash: proof.nullifier_hash },
    });
    const existingVerificationPrisma = await this.prisma.worldIdVerification.findUnique({
      where: { nullifierHash: proof.nullifier_hash },
    });

    if (existingVerificationTypeORM || existingVerificationPrisma) {
      throw new ConflictException('This Worldcoin proof has already been used');
    }

    // Create and save verification record in both (for compatibility)
    const verificationTypeORM = this.worldIdVerificationRepository.create({
      userId,
      nullifierHash: proof.nullifier_hash,
      verificationLevel: proof.verification_level,
      worldcoinAppId: this.configService.get<string>('WORLDCOIN_APP_ID'),
      worldcoinAction: action,
      merkleRoot: proof.merkle_root,
      proof: proof.proof,
    });
    const savedVerification = await this.worldIdVerificationRepository.save(verificationTypeORM);

    // Save to Prisma as well
    await this.prisma.worldIdVerification.create({
      data: {
        userId,
        nullifierHash: proof.nullifier_hash,
        verificationLevel: proof.verification_level,
        worldcoinAppId: this.configService.get<string>('WORLDCOIN_APP_ID') || '',
        worldcoinAction: action,
        merkleRoot: proof.merkle_root,
        proof: proof.proof,
      },
    });

    // Update user's worldcoinVerified status in Prisma
    await this.prisma.user.update({
      where: { id: userId },
      data: { worldcoinVerified: true },
    });

    // Recalculate sybil score
    await this.sybilResistanceService.recordSybilScore(userId);

    return savedVerification;
  }

  private async verifyWorldcoinProof(
    proof: VerifyWorldcoinProofDto['proof'],
    action: string,
    signal?: string,
  ): Promise<boolean> {
    try {
      const appId = this.configService.get<string>('WORLDCOIN_APP_ID');
      const expectedAction = this.configService.get<string>('WORLDCOIN_ACTION');
      const verifyBaseUrl =
        this.configService.get<string>('WORLDCOIN_VERIFY_BASE_URL') ??
        'https://developer.worldcoin.org/api/v2/verify';

      if (!appId || !expectedAction) {
        this.logger.error('Worldcoin configuration missing');
        return false;
      }

      if (action !== expectedAction) {
        this.logger.warn(`Worldcoin action mismatch: received ${action}, expected ${expectedAction}`);
        return false;
      }

      const response = await fetch(`${verifyBaseUrl}/${appId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...proof,
          action,
          ...(signal ? { signal } : {}),
        }),
      });

      if (!response.ok) {
        this.logger.warn(`Worldcoin verification request failed with status ${response.status}`);
        return false;
      }

      const result = (await response.json()) as WorldcoinCloudVerifyResponse;

      return result.success === true;
    } catch (error) {
      this.logger.error('Error verifying Worldcoin proof:', error);
      return false;
    }
  }

  async getVerificationStatus(userId: string): Promise<WorldIdVerification | null> {
    return await this.worldIdVerificationRepository.findOne({
      where: { userId },
      order: { verifiedAt: 'DESC' },
    });
  }

  async getVerificationByNullifierHash(nullifierHash: string): Promise<WorldIdVerification | null> {
    return await this.worldIdVerificationRepository.findOne({
      where: { nullifierHash },
    });
  }

  async isUserVerified(userId: string): Promise<boolean> {
    const verification = await this.getVerificationStatus(userId);
    const prismaVerification = await this.prisma.worldIdVerification.findFirst({
      where: { userId },
      orderBy: { verifiedAt: 'desc' },
    });
    return verification !== null || prismaVerification !== null;
  }
}
