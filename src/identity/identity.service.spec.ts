import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { verifyMessage } from 'ethers';

jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
}));

describe('IdentityService', () => {
  let service: IdentityService;
  let prisma: any;
  let auditTrail: any;

  const mockUser = {
    id: 'user-123',
    createdAt: new Date(),
    updatedAt: new Date(),
    reputation: 0,
    worldcoinVerified: false,
  };

  const mockSybilScore = {
    id: 'score-123',
    userId: mockUser.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    worldcoinScore: 0,
    walletAgeScore: 0,
    stakingScore: 0,
    accuracyScore: 0,
    compositeScore: 0,
  };

  const mockTransaction = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    wallet: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    sybilScore: {
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn((fn) => fn(mockTransaction)),
            user: {
              create: jest.fn(),
              findUnique: jest.fn(),
            },
            wallet: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              count: jest.fn(),
              delete: jest.fn(),
            },
            sybilScore: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: AuditTrailService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<IdentityService>(IdentityService);
    prisma = module.get(PrismaService);
    auditTrail = module.get(AuditTrailService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createUser', () => {
    it('should create a user and initial sybil score in a transaction', async () => {
      mockTransaction.user.create.mockResolvedValue(mockUser);
      mockTransaction.sybilScore.create.mockResolvedValue(mockSybilScore);

      const result = await service.createUser();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(mockTransaction.user.create).toHaveBeenCalledWith({ data: {} });
      expect(mockTransaction.sybilScore.create).toHaveBeenCalledWith({
        data: { userId: mockUser.id },
      });
      expect(result).toEqual(mockUser);
    });

    it('should rollback transaction if user creation fails', async () => {
      mockTransaction.user.create.mockRejectedValue(new Error('DB error'));

      await expect(service.createUser()).rejects.toThrow('DB error');

      expect(mockTransaction.sybilScore.create).not.toHaveBeenCalled();
    });

    it('should rollback transaction if sybil score creation fails', async () => {
      mockTransaction.user.create.mockResolvedValue(mockUser);
      mockTransaction.sybilScore.create.mockRejectedValue(
        new Error('Score creation failed'),
      );

      await expect(service.createUser()).rejects.toThrow(
        'Score creation failed',
      );
    });
  });

  describe('getUser', () => {
    it('should return user with wallets', async () => {
      const userWithWallets = { ...mockUser, wallets: [] };
      prisma.user.findUnique.mockResolvedValue(userWithWallets);

      const result = await service.getUser(mockUser.id);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        include: { wallets: true },
      });
      expect(result).toEqual(userWithWallets);
    });

    it('should throw NotFoundException if user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUser('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('linkWallet', () => {
    const mockLinkWalletDto: LinkWalletDto = {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chain: 'ETH',
      message: 'Link wallet',
      signature: '0xsignature',
    };

    beforeEach(() => {
      (verifyMessage as jest.Mock).mockReturnValue(
        '0x1234567890abcdef1234567890abcdef12345678',
      );
    });

    it('should link a wallet in a transaction', async () => {
      mockTransaction.wallet.findFirst.mockResolvedValue(null);
      mockTransaction.user.findUnique.mockResolvedValue(mockUser);
      const createdWallet = {
        id: 'wallet-123',
        address: mockLinkWalletDto.address,
        chain: mockLinkWalletDto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.create.mockResolvedValue(createdWallet);

      const result = await service.linkWallet(mockUser.id, mockLinkWalletDto);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(mockTransaction.wallet.findFirst).toHaveBeenCalledWith({
        where: { address: mockLinkWalletDto.address },
      });
      expect(mockTransaction.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id },
      });
      expect(mockTransaction.wallet.create).toHaveBeenCalledWith({
        data: {
          address: mockLinkWalletDto.address,
          chain: mockLinkWalletDto.chain,
          userId: mockUser.id,
        },
      });
      expect(result).toEqual(createdWallet);
    });

    it('should throw BadRequestException for invalid signature', async () => {
      (verifyMessage as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(
        service.linkWallet(mockUser.id, mockLinkWalletDto),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for address mismatch', async () => {
      (verifyMessage as jest.Mock).mockReturnValue(
        '0xdifferentaddress1234567890abcdef1234567890',
      );

      await expect(
        service.linkWallet(mockUser.id, mockLinkWalletDto),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should return existing wallet if same address and chain already linked to same user', async () => {
      const existingWallet = {
        id: 'wallet-123',
        address: mockLinkWalletDto.address,
        chain: mockLinkWalletDto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findFirst.mockResolvedValue(existingWallet);

      const result = await service.linkWallet(mockUser.id, mockLinkWalletDto);

      expect(result).toEqual(existingWallet);
      expect(mockTransaction.wallet.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if wallet linked to different user', async () => {
      const existingWallet = {
        id: 'wallet-456',
        address: mockLinkWalletDto.address,
        chain: 'ETH',
        userId: 'different-user',
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findFirst.mockResolvedValue(existingWallet);

      await expect(
        service.linkWallet(mockUser.id, mockLinkWalletDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should allow same wallet on different chain for same user', async () => {
      const existingWallet = {
        id: 'wallet-123',
        address: mockLinkWalletDto.address,
        chain: 'POLYGON',
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findFirst.mockResolvedValue(existingWallet);
      mockTransaction.user.findUnique.mockResolvedValue(mockUser);
      const newWallet = {
        id: 'wallet-789',
        address: mockLinkWalletDto.address,
        chain: mockLinkWalletDto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.create.mockResolvedValue(newWallet);

      const result = await service.linkWallet(mockUser.id, mockLinkWalletDto);

      expect(result).toEqual(newWallet);
      expect(mockTransaction.wallet.create).toHaveBeenCalled();
    });

    it('should throw NotFoundException if user does not exist', async () => {
      mockTransaction.wallet.findFirst.mockResolvedValue(null);
      mockTransaction.user.findUnique.mockResolvedValue(null);

      await expect(
        service.linkWallet('non-existent', mockLinkWalletDto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('unlinkWallet', () => {
    it('should delete a wallet', async () => {
      const wallet = {
        id: 'wallet-123',
        address: '0x123',
        chain: 'ETH',
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      prisma.wallet.findUnique.mockResolvedValue(wallet);
      prisma.wallet.count.mockResolvedValue(2);
      prisma.wallet.delete.mockResolvedValue(wallet);

      const result = await service.unlinkWallet(mockUser.id, '0x123', 'ETH');

      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
        where: {
          address_chain: {
            address: '0x123',
            chain: 'ETH',
          },
        },
      });
      expect(auditTrail.log).toHaveBeenCalledWith({
        actionType: AuditActionType.WALLET_UNLINKED,
        entityType: AuditEntityType.WALLET,
        entityId: wallet.id,
        userId: mockUser.id,
        walletAddress: '0x123',
        description: 'Wallet unlinked',
      });
      expect(prisma.wallet.delete).toHaveBeenCalledWith({
        where: {
          address_chain: {
            address: '0x123',
            chain: 'ETH',
          },
        },
      });
      expect(result).toEqual(wallet);
    });

    it('should throw NotFoundException if wallet not found', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.unlinkWallet(mockUser.id, '0x123', 'ETH'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if wallet belongs to different user', async () => {
      const wallet = {
        id: 'wallet-123',
        address: '0x123',
        chain: 'ETH',
        userId: 'different-user',
        linkedAt: new Date(),
      };
      prisma.wallet.findUnique.mockResolvedValue(wallet);

      await expect(
        service.unlinkWallet(mockUser.id, '0x123', 'ETH'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findUserByAddress', () => {
    it('should return user for a given wallet address', async () => {
      const wallet = {
        id: 'wallet-123',
        address: '0x123',
        chain: 'ETH',
        userId: mockUser.id,
        linkedAt: new Date(),
        user: mockUser,
      };
      prisma.wallet.findFirst.mockResolvedValue(wallet);

      const result = await service.findUserByAddress('0x123');

      expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { address: '0x123' },
        include: { user: true },
      });
      expect(result).toEqual(mockUser);
    });

    it('should return null if no wallet found', async () => {
      prisma.wallet.findFirst.mockResolvedValue(null);

      const result = await service.findUserByAddress('0x123');

      expect(result).toBeNull();
    });
  });
});
