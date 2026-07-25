import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorldcoinService } from './worldcoin.service';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { PrismaService } from '../../prisma/prisma.service';
import { SybilResistanceService } from '../../sybil-resistance/sybil-resistance.service';

// Prevent native @libsql binaries from loading during unit tests
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));
jest.mock('../../sybil-resistance/sybil-resistance.service', () => ({
  SybilResistanceService: jest.fn(),
}));

describe('WorldcoinService', () => {
  let service: WorldcoinService;
  let repository: jest.Mocked<Repository<WorldIdVerification>>;
  let configService: jest.Mocked<ConfigService>;
  let prisma: any;
  let sybilResistanceService: jest.Mocked<SybilResistanceService>;
  let fetchMock: jest.Mock;

  const mockRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockPrisma = {
    worldIdVerification: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
  };

  const mockSybilResistanceService = {
    recordSybilScore: jest.fn(),
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
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: SybilResistanceService,
          useValue: mockSybilResistanceService,
        },
      ],
    }).compile();

    service = module.get<WorldcoinService>(WorldcoinService);
    repository = module.get(getRepositoryToken(WorldIdVerification));
    configService = module.get(ConfigService);
    prisma = module.get<any>(PrismaService);
    sybilResistanceService = module.get(SybilResistanceService) as jest.Mocked<SybilResistanceService>;
    fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    configService.get.mockImplementation((key: string) => {
      const config: Record<string, string> = {
        WORLDCOIN_APP_ID: 'test-app-id',
        WORLDCOIN_ACTION: 'test-action',
        WORLDCOIN_VERIFY_BASE_URL: 'https://developer.worldcoin.org/api/v2/verify',
      };
      return config[key];
    });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true }),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findUnique.mockResolvedValue(null);

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
      prisma.worldIdVerification.create.mockResolvedValue(mockVerification);
      prisma.user.update.mockResolvedValue({});
      sybilResistanceService.recordSybilScore.mockResolvedValue({ compositeScore: 0.5 });

      const result = await service.verifyProof(userId, verifyDto);

      expect(result).toEqual(mockVerification);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://developer.worldcoin.org/api/v2/verify/test-app-id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...verifyDto.proof,
            action: verifyDto.action,
            signal: verifyDto.signal,
          }),
        },
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

    it('should write verification to both TypeORM and Prisma (dual-write sync)', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findUnique.mockResolvedValue(null);

      const mockVerification = {
        id: 'ver-1',
        userId,
        nullifierHash: verifyDto.proof.nullifier_hash,
        verifiedAt: new Date(),
      } as unknown as WorldIdVerification;

      repository.create.mockReturnValue(mockVerification);
      repository.save.mockResolvedValue(mockVerification);
      prisma.worldIdVerification.create.mockResolvedValue(mockVerification);
      prisma.user.update.mockResolvedValue({});
      sybilResistanceService.recordSybilScore.mockResolvedValue({ compositeScore: 0.5 });

      await service.verifyProof(userId, verifyDto);

      // Verify both stores were written
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(prisma.worldIdVerification.create).toHaveBeenCalledTimes(1);
      expect(prisma.worldIdVerification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId,
            nullifierHash: verifyDto.proof.nullifier_hash,
          }),
        }),
      );
    });

    it('should set worldcoinVerified=true on User via Prisma after successful verification', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findUnique.mockResolvedValue(null);

      const mockVerification = { id: 'ver-1', userId, nullifierHash: verifyDto.proof.nullifier_hash } as unknown as WorldIdVerification;
      repository.create.mockReturnValue(mockVerification);
      repository.save.mockResolvedValue(mockVerification);
      prisma.worldIdVerification.create.mockResolvedValue(mockVerification);
      prisma.user.update.mockResolvedValue({});
      sybilResistanceService.recordSybilScore.mockResolvedValue({ compositeScore: 0.5 });

      await service.verifyProof(userId, verifyDto);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { worldcoinVerified: true },
      });
    });

    it('should trigger sybil score recalculation after verification', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findUnique.mockResolvedValue(null);

      const mockVerification = { id: 'ver-1', userId } as unknown as WorldIdVerification;
      repository.create.mockReturnValue(mockVerification);
      repository.save.mockResolvedValue(mockVerification);
      prisma.worldIdVerification.create.mockResolvedValue(mockVerification);
      prisma.user.update.mockResolvedValue({});
      sybilResistanceService.recordSybilScore.mockResolvedValue({ compositeScore: 0.5 });

      await service.verifyProof(userId, verifyDto);

      expect(sybilResistanceService.recordSybilScore).toHaveBeenCalledWith(userId);
    });

    it('should throw ConflictException when nullifier hash exists in TypeORM store', async () => {
      repository.findOne.mockResolvedValue({
        id: 'existing',
        userId: 'other-user',
        nullifierHash: verifyDto.proof.nullifier_hash,
      } as WorldIdVerification);
      prisma.worldIdVerification.findUnique.mockResolvedValue(null);

      await expect(service.verifyProof(userId, verifyDto)).rejects.toThrow(
        'This Worldcoin proof has already been used',
      );
    });

    it('should throw ConflictException when nullifier hash exists in Prisma store', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findUnique.mockResolvedValue({
        id: 'existing-prisma',
        nullifierHash: verifyDto.proof.nullifier_hash,
      });

      await expect(service.verifyProof(userId, verifyDto)).rejects.toThrow(
        'This Worldcoin proof has already been used',
      );
    });

    it('should throw BadRequestException for invalid proof', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: false }),
      });
      repository.findOne.mockResolvedValue(null);

      await expect(service.verifyProof(userId, verifyDto)).rejects.toThrow(
        'Invalid Worldcoin proof',
      );
    });

    it('should throw BadRequestException when the action does not match config', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.verifyProof(userId, { ...verifyDto, action: 'unexpected-action' }),
      ).rejects.toThrow('Invalid Worldcoin proof');

      expect(fetchMock).not.toHaveBeenCalled();
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
    it('should return true when TypeORM store has a verification record', async () => {
      const userId = 'test-user-123';
      repository.findOne.mockResolvedValue({ id: 'verification-id' } as WorldIdVerification);
      prisma.worldIdVerification.findFirst.mockResolvedValue(null);

      const result = await service.isUserVerified(userId);

      expect(result).toBe(true);
    });

    it('should return true when Prisma store has a verification record', async () => {
      const userId = 'test-user-123';
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findFirst.mockResolvedValue({ id: 'prisma-ver' });

      const result = await service.isUserVerified(userId);

      expect(result).toBe(true);
    });

    it('should return false when neither store has a verification record', async () => {
      const userId = 'test-user-123';
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findFirst.mockResolvedValue(null);

      const result = await service.isUserVerified(userId);

      expect(result).toBe(false);
    });
  });
});
