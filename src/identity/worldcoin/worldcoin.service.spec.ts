import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorldcoinService } from './worldcoin.service';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { verifyCloudProof } from '@worldcoin/minikit-js';

jest.mock('@worldcoin/minikit-js');

describe('WorldcoinService', () => {
  let service: WorldcoinService;
  let repository: jest.Mocked<Repository<WorldIdVerification>>;
  let configService: jest.Mocked<ConfigService>;

  const mockRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorldcoinService,
        {
          provide: getRepositoryToken(WorldIdVerification),
          useValue: mockRepository,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<WorldcoinService>(WorldcoinService);
    repository = module.get(getRepositoryToken(WorldIdVerification));
    configService = module.get(ConfigService);

    // Setup default config values
    configService.get.mockImplementation((key: string) => {
      const config = {
        'WORLDCOIN_APP_ID': 'test-app-id',
        'WORLDCOIN_ACTION': 'test-action',
      };
      return config[key];
    });

    // Mock verifyCloudProof to return success by default
    (verifyCloudProof as jest.Mock).mockResolvedValue({ success: true });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('verifyProof', () => {
    const userId = 'test-user-123';
    const verifyDto = {
      proof: {
        merkle_root: '0x123',
        nullifier_hash: '0x456',
        proof: '0x789',
        verification_level: 'orb',
      },
      action: 'test-action',
      signal: 'test-signal',
    };

    it('should successfully verify a valid Worldcoin proof', async () => {
      // Mock no existing verification
      repository.findOne.mockResolvedValue(null);
      
      // Mock created verification
      const mockVerification = {
        id: 'verification-id',
        userId,
        nullifierHash: verifyDto.proof.nullifier_hash,
        verificationLevel: verifyDto.proof.verification_level,
        worldcoinAppId: 'test-app-id',
        worldcoinAction: verifyDto.action,
        verifiedAt: new Date(),
      };
      
      repository.create.mockReturnValue(mockVerification);
      repository.save.mockResolvedValue(mockVerification);

      const result = await service.verifyProof(userId, verifyDto);

      expect(result).toEqual(mockVerification);
      expect(verifyCloudProof).toHaveBeenCalledWith(
        verifyDto.proof,
        'app_test-app-id',
        verifyDto.action,
        verifyDto.signal,
      );
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { nullifierHash: verifyDto.proof.nullifier_hash },
      });
      expect(repository.create).toHaveBeenCalledWith({
        userId,
        nullifierHash: verifyDto.proof.nullifier_hash,
        verificationLevel: verifyDto.proof.verification_level,
        worldcoinAppId: 'test-app-id',
        worldcoinAction: verifyDto.action,
        merkleRoot: verifyDto.proof.merkle_root,
        proof: verifyDto.proof.proof,
      });
    });

    it('should throw ConflictException for duplicate nullifier hash', async () => {
      // Mock existing verification
      repository.findOne.mockResolvedValue({
        id: 'existing-verification',
        userId: 'other-user',
        nullifierHash: verifyDto.proof.nullifier_hash,
      } as WorldIdVerification);

      await expect(service.verifyProof(userId, verifyDto)).rejects.toThrow(
        'This Worldcoin proof has already been used',
      );

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { nullifierHash: verifyDto.proof.nullifier_hash },
      });
    });

    it('should throw BadRequestException for invalid proof', async () => {
      // Mock verifyCloudProof to return failure
      (verifyCloudProof as jest.Mock).mockResolvedValue({ success: false });

      repository.findOne.mockResolvedValue(null);

      await expect(service.verifyProof(userId, verifyDto)).rejects.toThrow(
        'Invalid Worldcoin proof',
      );
    });
  });

  describe('getVerificationStatus', () => {
    it('should return verification status for user', async () => {
      const userId = 'test-user-123';
      const mockVerification = {
        id: 'verification-id',
        userId,
        verificationLevel: 'orb',
        verifiedAt: new Date(),
      };

      repository.findOne.mockResolvedValue(mockVerification as WorldIdVerification);

      const result = await service.getVerificationStatus(userId);

      expect(result).toEqual(mockVerification);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { userId },
        order: { verifiedAt: 'DESC' },
      });
    });
  });

  describe('isUserVerified', () => {
    it('should return true for verified user', async () => {
      const userId = 'test-user-123';
      repository.findOne.mockResolvedValue({ id: 'verification-id' } as WorldIdVerification);

      const result = await service.isUserVerified(userId);

      expect(result).toBe(true);
    });

    it('should return false for unverified user', async () => {
      const userId = 'test-user-123';
      repository.findOne.mockResolvedValue(null);

      const result = await service.isUserVerified(userId);

      expect(result).toBe(false);
    });
  });
});
