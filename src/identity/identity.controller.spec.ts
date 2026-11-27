import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { LinkWalletDto } from './dto/link-wallet.dto';
import {
  AdminLinkWalletDto,
  AdminUnlinkWalletDto,
} from './dto/admin-wallet.dto';

describe('IdentityController', () => {
  let controller: IdentityController;
  let identityService: jest.Mocked<IdentityService>;
  let sybilService: jest.Mocked<SybilResistanceService>;

  const makeAuthReq = (
    userId: string,
    role: 'contributor' | 'moderator' | 'admin' = 'contributor',
  ): AuthenticatedRequest => ({
    user: {
      sub: userId,
      userId,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      user: { role },
    },
  });

  const sampleLinkDto: LinkWalletDto = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    chain: 'ETH',
    signature: '0xvalidsignature',
    message: 'TruthBounty Wallet Link Challenge',
    nonce: 'nonce-123',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        {
          provide: IdentityService,
          useValue: {
            createUser: jest.fn(),
            getUser: jest.fn(),
            issueWalletLinkChallenge: jest.fn(),
            linkWallet: jest.fn(),
            unlinkWallet: jest.fn(),
            adminLinkWallet: jest.fn(),
            adminUnlinkWallet: jest.fn(),
          },
        },
        {
          provide: SybilResistanceService,
          useValue: {
            getLatestSybilScore: jest.fn(),
            setWorldcoinVerified: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<IdentityController>(IdentityController);
    identityService = module.get(IdentityService);
    sybilService = module.get(SybilResistanceService);
    jest.clearAllMocks();
  });

  describe('self-service principal binding', () => {
    it('rejects User A linking a wallet to User B account before service mutation', () => {
      const reqUserA = makeAuthReq('user-A');

      expect(() =>
        controller.linkWallet('user-B', sampleLinkDto, reqUserA),
      ).toThrow(ForbiddenException);

      expect(identityService.linkWallet).not.toHaveBeenCalled();
    });

    it('rejects User A unlinking a wallet from User B account before service mutation', () => {
      const reqUserA = makeAuthReq('user-A');

      expect(() =>
        controller.unlinkWallet(
          'user-B',
          'ETH',
          sampleLinkDto.address,
          reqUserA,
        ),
      ).toThrow(ForbiddenException);

      expect(identityService.unlinkWallet).not.toHaveBeenCalled();
    });

    it('rejects User A requesting a wallet-link challenge for User B account', () => {
      const reqUserA = makeAuthReq('user-A');

      expect(() =>
        controller.issueWalletLinkChallenge(
          'user-B',
          { address: sampleLinkDto.address, chain: 'ETH' },
          reqUserA,
        ),
      ).toThrow(ForbiddenException);

      expect(identityService.issueWalletLinkChallenge).not.toHaveBeenCalled();
    });

    it('fails closed with UnauthorizedException when request has no verified principal', () => {
      const unauthReq = {} as AuthenticatedRequest;

      expect(() =>
        controller.linkWallet('user-A', sampleLinkDto, unauthReq),
      ).toThrow(UnauthorizedException);

      expect(identityService.linkWallet).not.toHaveBeenCalled();
    });

    it('derives target user ID from verified principal when path matches principal', async () => {
      const reqUserA = makeAuthReq('user-A');
      identityService.linkWallet.mockResolvedValue({
        wallet: {
          id: 'w-1',
          address: sampleLinkDto.address,
          chain: 'ETH',
          userId: 'user-A',
          linkedAt: new Date(),
        },
        alreadyLinked: false,
      });

      await controller.linkWallet('user-A', sampleLinkDto, reqUserA);

      expect(identityService.linkWallet).toHaveBeenCalledWith(
        'user-A',
        sampleLinkDto,
      );
    });

    it('unlinks wallet for verified principal when path matches principal', async () => {
      const reqUserA = makeAuthReq('user-A');
      identityService.unlinkWallet.mockResolvedValue({
        id: 'w-1',
        address: sampleLinkDto.address,
        chain: 'ETH',
        userId: 'user-A',
        linkedAt: new Date(),
      });

      await controller.unlinkWallet(
        'user-A',
        'ETH',
        sampleLinkDto.address,
        reqUserA,
      );

      expect(identityService.unlinkWallet).toHaveBeenCalledWith(
        'user-A',
        sampleLinkDto.address,
        'ETH',
      );
    });
  });

  describe('admin-assisted routes', () => {
    const reflector = new Reflector();

    it('requires admin role metadata on admin wallet-link, unlink, and challenge routes', () => {
      expect(
        reflector.get(ROLES_KEY, IdentityController.prototype.adminLinkWallet),
      ).toEqual(['admin']);
      expect(
        reflector.get(
          ROLES_KEY,
          IdentityController.prototype.adminUnlinkWallet,
        ),
      ).toEqual(['admin']);
      expect(
        reflector.get(
          ROLES_KEY,
          IdentityController.prototype.adminIssueWalletLinkChallenge,
        ),
      ).toEqual(['admin']);
    });

    it('forwards actorId and reason to identityService.adminLinkWallet', async () => {
      const adminReq = makeAuthReq('admin-1', 'admin');
      const dto: AdminLinkWalletDto = {
        ...sampleLinkDto,
        reason: 'Support recovery #1042',
      };

      await controller.adminLinkWallet('user-B', dto, adminReq);

      expect(identityService.adminLinkWallet).toHaveBeenCalledWith(
        'user-B',
        dto,
        'admin-1',
      );
    });

    it('forwards actorId and reason to identityService.adminUnlinkWallet', async () => {
      const adminReq = makeAuthReq('admin-1', 'admin');
      const dto: AdminUnlinkWalletDto = {
        reason: 'Compromised key revocation #1043',
      };

      await controller.adminUnlinkWallet(
        'user-B',
        'ETH',
        sampleLinkDto.address,
        dto,
        adminReq,
      );

      expect(identityService.adminUnlinkWallet).toHaveBeenCalledWith(
        'user-B',
        sampleLinkDto.address,
        'ETH',
        'admin-1',
        dto.reason,
      );
    });
  });

  describe('Worldcoin boolean verification route removal', () => {
    it('does not expose a direct verifyWorldcoin boolean route on IdentityController', () => {
      expect((controller as any).verifyWorldcoin).toBeUndefined();
      expect(sybilService.setWorldcoinVerified).not.toHaveBeenCalled();
    });
  });
});
