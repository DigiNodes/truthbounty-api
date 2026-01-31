import { Injectable, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { verifyCloudProof } from '@worldcoin/minikit-js';

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

@Injectable()
export class WorldcoinService {
  private readonly logger = new Logger(WorldcoinService.name);

  constructor(
    @InjectRepository(WorldIdVerification)
    private readonly worldIdVerificationRepository: Repository<WorldIdVerification>,
    private readonly configService: ConfigService,
  ) {}

  async verifyProof(userId: string, verifyDto: VerifyWorldcoinProofDto): Promise<WorldIdVerification> {
    const { proof, action, signal } = verifyDto;

    // Verify the proof with Worldcoin
    const isValid = await this.verifyWorldcoinProof(proof, action, signal);
    
    if (!isValid) {
      throw new BadRequestException('Invalid Worldcoin proof');
    }

    // Check if nullifier hash has already been used (prevent duplicate verification)
    const existingVerification = await this.worldIdVerificationRepository.findOne({
      where: { nullifierHash: proof.nullifier_hash },
    });

    if (existingVerification) {
      throw new ConflictException('This Worldcoin proof has already been used');
    }

    // Create and save verification record
    const verification = this.worldIdVerificationRepository.create({
      userId,
      nullifierHash: proof.nullifier_hash,
      verificationLevel: proof.verification_level,
      worldcoinAppId: this.configService.get<string>('WORLDCOIN_APP_ID'),
      worldcoinAction: action,
      merkleRoot: proof.merkle_root,
      proof: proof.proof,
    });

    return await this.worldIdVerificationRepository.save(verification);
  }

  private async verifyWorldcoinProof(
    proof: any,
    action: string,
    signal?: string,
  ): Promise<boolean> {
    try {
      const appId = this.configService.get<string>('WORLDCOIN_APP_ID');
      const expectedAction = this.configService.get<string>('WORLDCOIN_ACTION');

      if (!appId || !expectedAction) {
        this.logger.error('Worldcoin configuration missing');
        return false;
      }

      // Verify the proof using Worldcoin SDK
      // The appId should be prefixed with 'app_' for the SDK
      const app_id = appId.startsWith('app_') ? appId as `app_${string}` : `app_${appId}` as `app_${string}`;
      const result = await verifyCloudProof(proof, app_id, action, signal);
      
      return result.success;
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
    return verification !== null;
  }
}
