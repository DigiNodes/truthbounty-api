import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import {
  WALLET_LINK_OPERATION,
  WalletLinkChallengeService,
} from './wallet-link-challenge.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';
import { Prisma } from '../generated/client/client';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { AdminLinkWalletDto } from './dto/admin-wallet.dto';
import { verifyMessage } from 'ethers';

jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
  // Identity passthrough: the specs use short placeholder addresses (e.g. '0x123')
  // that real EIP-55 checksumming would reject. The service's timing-safe,
  // case-insensitive comparison is exercised with the raw values instead.
  getAddress: jest.fn((address: string) => address),
}));

describe('IdentityService', () => {
  let service: IdentityService;
  let challengeService: WalletLinkChallengeService;
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
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
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
        WalletLinkChallengeService,
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
              findMany: jest.fn(),
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
    challengeService = module.get<WalletLinkChallengeService>(
      WalletLinkChallengeService,
    );
    prisma = module.get(PrismaService);
    auditTrail = module.get(AuditTrailService);

    jest.clearAllMocks();
  });

  const createChallengeDto = (
    userId: string,
    address = '0x1234567890abcdef1234567890abcdef12345678',
    chain = 'ETH',
    ttlMs?: number,
  ): LinkWalletDto => {
    const challenge = challengeService.issueChallenge({
      userId,
      address,
      chain,
      ttlMs,
    });
    return {
      address,
      chain,
      message: challenge.message,
      nonce: challenge.nonce,
      signature: '0xsignature',
    };
  };

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
    const walletAddress = '0x1234567890abcdef1234567890abcdef12345678';

    beforeEach(() => {
      (verifyMessage as jest.Mock).mockReturnValue(walletAddress);
    });

    it('should link a wallet in a transaction with a valid single-use challenge and audit log', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      mockTransaction.wallet.findMany.mockResolvedValue([]);
      mockTransaction.user.findUnique.mockResolvedValue(mockUser);
      const createdWallet = {
        id: 'wallet-123',
        address: dto.address,
        chain: dto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.create.mockResolvedValue(createdWallet);

      const result = await service.linkWallet(mockUser.id, dto);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(mockTransaction.wallet.findMany).toHaveBeenCalledWith({
        where: { address: dto.address },
      });
      expect(mockTransaction.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id },
      });
      expect(mockTransaction.wallet.create).toHaveBeenCalledWith({
        data: {
          address: dto.address,
          chain: dto.chain,
          userId: mockUser.id,
        },
      });
      expect(auditTrail.log).toHaveBeenCalledWith({
        actionType: AuditActionType.WALLET_LINKED,
        entityType: AuditEntityType.WALLET,
        entityId: createdWallet.id,
        userId: mockUser.id,
        walletAddress: dto.address,
        description: 'Wallet linked',
        metadata: { chain: 'ETH' },
      });
      expect(result).toEqual({ wallet: createdWallet, alreadyLinked: false });
    });

    it('should reject an arbitrary message without a server-issued challenge', async () => {
      await expect(
        service.linkWallet(mockUser.id, {
          address: walletAddress,
          chain: 'ETH',
          message: 'Arbitrary replayable message',
          nonce: 'unknown-nonce',
          signature: '0xsignature',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should reject replay of a consumed wallet-link challenge (single-use)', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      mockTransaction.wallet.findMany.mockResolvedValue([]);
      mockTransaction.user.findUnique.mockResolvedValue(mockUser);
      mockTransaction.wallet.create.mockResolvedValue({
        id: 'wallet-123',
        address: dto.address,
        chain: dto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      });

      await service.linkWallet(mockUser.id, dto);

      await expect(service.linkWallet(mockUser.id, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject a challenge bound to a different account', async () => {
      const dto = createChallengeDto('user-A', walletAddress, 'ETH');

      await expect(service.linkWallet('user-B', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should reject a challenge bound to a different chain', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');

      await expect(
        service.linkWallet(mockUser.id, { ...dto, chain: 'POLYGON' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should reject a challenge bound to a different address', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');

      await expect(
        service.linkWallet(mockUser.id, {
          ...dto,
          address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should reject an expired wallet-link challenge', async () => {
      const challenge = challengeService.issueChallenge({
        userId: mockUser.id,
        address: walletAddress,
        chain: 'ETH',
        ttlMs: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(
        service.linkWallet(mockUser.id, {
          address: walletAddress,
          chain: 'ETH',
          message: challenge.message,
          nonce: challenge.nonce,
          signature: '0xsignature',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should bind challenge message to operation, account, address, chain, nonce, and expiry', () => {
      const challenge = service.issueWalletLinkChallenge(
        mockUser.id,
        walletAddress,
        'ETH',
      );

      expect(challenge.operation).toBe(WALLET_LINK_OPERATION);
      expect(challenge.message).toContain(`Operation: ${WALLET_LINK_OPERATION}`);
      expect(challenge.message).toContain(`Account: ${mockUser.id}`);
      expect(challenge.message).toContain(`Address: ${walletAddress}`);
      expect(challenge.message).toContain('Chain: ETH');
      expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
      expect(challenge.message).toContain(
        `Expires At: ${challenge.expiresAt.toISOString()}`,
      );
    });

    it('should throw BadRequestException for invalid signature', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      (verifyMessage as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(service.linkWallet(mockUser.id, dto)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for address mismatch', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      (verifyMessage as jest.Mock).mockReturnValue(
        '0xdifferentaddress1234567890abcdef1234567890',
      );

      await expect(service.linkWallet(mockUser.id, dto)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should return existing wallet if same address and chain already linked to same user', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      const existingWallet = {
        id: 'wallet-123',
        address: dto.address,
        chain: dto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findMany.mockResolvedValue([existingWallet]);

      const result = await service.linkWallet(mockUser.id, dto);

      expect(result).toEqual({ wallet: existingWallet, alreadyLinked: true });
      expect(mockTransaction.wallet.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if wallet linked to different user (never moves wallet)', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      const existingWallet = {
        id: 'wallet-456',
        address: dto.address,
        chain: 'ETH',
        userId: 'different-user',
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findMany.mockResolvedValue([existingWallet]);

      await expect(service.linkWallet(mockUser.id, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(mockTransaction.wallet.create).not.toHaveBeenCalled();
    });

    it('should allow same wallet on different chain for same user', async () => {
      const dto = createChallengeDto(mockUser.id, walletAddress, 'ETH');
      const existingWallet = {
        id: 'wallet-123',
        address: dto.address,
        chain: 'POLYGON',
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findMany.mockResolvedValue([existingWallet]);
      mockTransaction.user.findUnique.mockResolvedValue(mockUser);
      const newWallet = {
        id: 'wallet-789',
        address: dto.address,
        chain: dto.chain,
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.create.mockResolvedValue(newWallet);

      const result = await service.linkWallet(mockUser.id, dto);

      expect(result).toEqual({ wallet: newWallet, alreadyLinked: false });
      expect(mockTransaction.wallet.create).toHaveBeenCalled();
    });

    it('should preserve unique wallet ownership on concurrent link attempts (P2002)', async () => {
      const dtoA = createChallengeDto('user-A', walletAddress, 'ETH');
      const dtoB = createChallengeDto('user-B', walletAddress, 'ETH');

      mockTransaction.wallet.findMany.mockResolvedValue([]);
      mockTransaction.user.findUnique
        .mockResolvedValueOnce({ ...mockUser, id: 'user-A' })
        .mockResolvedValueOnce({ ...mockUser, id: 'user-B' });

      const createdWallet = {
        id: 'wallet-win',
        address: walletAddress,
        chain: 'ETH',
        userId: 'user-A',
        linkedAt: new Date(),
      };
      const uniqueErr = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: 'test' },
      );

      mockTransaction.wallet.create
        .mockResolvedValueOnce(createdWallet)
        .mockRejectedValueOnce(uniqueErr);

      const [first, second] = await Promise.allSettled([
        service.linkWallet('user-A', dtoA),
        service.linkWallet('user-B', dtoB),
      ]);

      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('rejected');
      if (second.status === 'rejected') {
        expect(second.reason).toBeInstanceOf(ConflictException);
      }
    });

    it('should throw NotFoundException if user does not exist', async () => {
      const dto = createChallengeDto('non-existent', walletAddress, 'ETH');
      mockTransaction.wallet.findMany.mockResolvedValue([]);
      mockTransaction.user.findUnique.mockResolvedValue(null);

      await expect(service.linkWallet('non-existent', dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('adminLinkWallet', () => {
    const walletAddress = '0x1234567890abcdef1234567890abcdef12345678';

    beforeEach(() => {
      (verifyMessage as jest.Mock).mockReturnValue(walletAddress);
    });

    it('should link wallet for target user and record admin audit metadata', async () => {
      const baseDto = createChallengeDto('target-user', walletAddress, 'ETH');
      const adminDto: AdminLinkWalletDto = {
        ...baseDto,
        reason: 'Account recovery ticket #9912',
      };
      mockTransaction.wallet.findMany.mockResolvedValue([]);
      mockTransaction.user.findUnique.mockResolvedValue({
        ...mockUser,
        id: 'target-user',
      });
      const createdWallet = {
        id: 'wallet-admin-1',
        address: walletAddress,
        chain: 'ETH',
        userId: 'target-user',
        linkedAt: new Date(),
      };
      mockTransaction.wallet.create.mockResolvedValue(createdWallet);

      const result = await service.adminLinkWallet(
        'target-user',
        adminDto,
        'admin-actor-1',
      );

      expect(result).toEqual({ wallet: createdWallet, alreadyLinked: false });
      expect(auditTrail.log).toHaveBeenCalledWith({
        actionType: AuditActionType.WALLET_LINKED,
        entityType: AuditEntityType.WALLET,
        entityId: createdWallet.id,
        userId: 'target-user',
        walletAddress,
        description: 'Wallet linked by administrator',
        metadata: {
          chain: 'ETH',
          adminAssisted: true,
          actorId: 'admin-actor-1',
          reason: 'Account recovery ticket #9912',
        },
      });
    });
  });

  describe('unlinkWallet', () => {
    it('should atomically delete a wallet inside a transaction and audit log it', async () => {
      const wallet = {
        id: 'wallet-123',
        address: '0x123',
        chain: 'ETH',
        userId: mockUser.id,
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findUnique.mockResolvedValue(wallet);
      mockTransaction.wallet.count.mockResolvedValue(2);
      mockTransaction.wallet.delete.mockResolvedValue(wallet);

      const result = await service.unlinkWallet(mockUser.id, '0x123', 'ETH');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(mockTransaction.wallet.findUnique).toHaveBeenCalledWith({
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
        metadata: { chain: 'ETH' },
      });
      expect(mockTransaction.wallet.delete).toHaveBeenCalledWith({
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
      mockTransaction.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.unlinkWallet(mockUser.id, '0x123', 'ETH'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException (constant-shape) if wallet belongs to different user', async () => {
      const wallet = {
        id: 'wallet-123',
        address: '0x123',
        chain: 'ETH',
        userId: 'different-user',
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findUnique.mockResolvedValue(wallet);

      // issue-416: not-found and not-owned collapse to the same shape so
      // ownership cannot be enumerated.
      await expect(
        service.unlinkWallet(mockUser.id, '0x123', 'ETH'),
      ).rejects.toThrow(NotFoundException);
      expect(mockTransaction.wallet.delete).not.toHaveBeenCalled();
    });
  });

  describe('adminUnlinkWallet', () => {
    it('should unlink wallet for target user and record admin audit metadata', async () => {
      const wallet = {
        id: 'wallet-admin-2',
        address: '0x123',
        chain: 'ETH',
        userId: 'target-user',
        linkedAt: new Date(),
      };
      mockTransaction.wallet.findUnique.mockResolvedValue(wallet);
      mockTransaction.wallet.count.mockResolvedValue(2);
      mockTransaction.wallet.delete.mockResolvedValue(wallet);

      const result = await service.adminUnlinkWallet(
        'target-user',
        '0x123',
        'ETH',
        'admin-actor-1',
        'Compromised wallet revocation #4401',
      );

      expect(result).toEqual(wallet);
      expect(auditTrail.log).toHaveBeenCalledWith({
        actionType: AuditActionType.WALLET_UNLINKED,
        entityType: AuditEntityType.WALLET,
        entityId: wallet.id,
        userId: 'target-user',
        walletAddress: '0x123',
        description: 'Wallet unlinked by administrator',
        metadata: {
          chain: 'ETH',
          adminAssisted: true,
          actorId: 'admin-actor-1',
          reason: 'Compromised wallet revocation #4401',
        },
      });
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
