import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { WalletIdentityService } from './wallet-identity.service';
import { WalletIdentity } from './entities/wallet-identity.entity';
import { AuthSessionService } from './auth-session.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType } from '../audit/entities/audit-log.entity';

const ADDR = '0xaAbBcCdDeEfF001122334455667788990011aabb';
const CHAIN = 10;
const USER = 'user-1';

function makeIdentity(overrides: Partial<WalletIdentity> = {}): WalletIdentity {
  return {
    id: 'identity-uuid-1',
    walletAddress: ADDR.toLowerCase(),
    chainId: CHAIN,
    userId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface MockRepo {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
}

function mockRepo(overrides: Partial<MockRepo> = {}): MockRepo {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) => input),
    save: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'new-uuid', ...input }),
      ),
    remove: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(input),
      ),
    ...overrides,
  };
}

describe('WalletIdentityService', () => {
  let service: WalletIdentityService;
  let repo: MockRepo;
  let authSessions: {
    validateForPrincipal: jest.Mock;
    revokeAll: jest.Mock;
  };
  let auditTrail: { log: jest.Mock };

  beforeEach(async () => {
    repo = mockRepo();
    authSessions = {
      validateForPrincipal: jest.fn().mockResolvedValue({
        id: 'session-uuid-1',
        walletAddress: ADDR.toLowerCase(),
        chainId: CHAIN,
      }),
      revokeAll: jest.fn().mockResolvedValue(0),
    };
    auditTrail = { log: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletIdentityService,
        { provide: getRepositoryToken(WalletIdentity), useValue: repo },
        { provide: AuthSessionService, useValue: authSessions },
        { provide: AuditTrailService, useValue: auditTrail },
      ],
    }).compile();
    service = module.get(WalletIdentityService);
  });

  describe('bind', () => {
    it('binds a wallet that is not yet bound', async () => {
      const result = await service.bind(USER, ADDR, CHAIN);
      expect(result.alreadyBound).toBe(false);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          walletAddress: ADDR.toLowerCase(),
          chainId: CHAIN,
        }),
      );
    });

    it('normalises the address to lowercase', async () => {
      await service.bind(USER, ADDR, CHAIN);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: ADDR.toLowerCase() }),
      );
    });

    it('is idempotent when the same user binds again', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      const result = await service.bind(USER, ADDR, CHAIN);
      expect(result.alreadyBound).toBe(true);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a wallet already bound to another user', async () => {
      repo.findOne.mockResolvedValue(makeIdentity({ userId: 'someone-else' }));
      await expect(service.bind(USER, ADDR, CHAIN)).rejects.toThrow(
        ConflictException,
      );
    });

    it('turns a unique-index violation into a conflict', async () => {
      // First read sees nothing; the racing bind lands, then the re-read after
      // the failed insert finds another user's binding.
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeIdentity({ userId: 'someone-else' }));
      repo.save.mockRejectedValue({ driverError: { code: '23505' } });
      await expect(service.bind(USER, ADDR, CHAIN)).rejects.toThrow(
        ConflictException,
      );
    });

    it('stays idempotent when the racing bind used the same user', async () => {
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeIdentity());
      repo.save.mockRejectedValue({ driverError: { code: '23505' } });

      const result = await service.bind(USER, ADDR, CHAIN);

      expect(result.alreadyBound).toBe(true);
      expect(result.identity.userId).toBe(USER);
    });

    it('rethrows a non-unique save failure untouched', async () => {
      repo.save.mockRejectedValue(new Error('connection reset'));
      await expect(service.bind(USER, ADDR, CHAIN)).rejects.toThrow(
        'connection reset',
      );
    });

    it('rejects an invalid address', async () => {
      await expect(service.bind(USER, 'not-an-addr', CHAIN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects chainId = 0', async () => {
      await expect(service.bind(USER, ADDR, 0)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a chainId beyond the 32-bit column range', async () => {
      await expect(service.bind(USER, ADDR, 2147483648)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects an empty userId', async () => {
      await expect(service.bind('', ADDR, CHAIN)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resolveUser', () => {
    it('returns the owning user', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      await expect(service.resolveUser(ADDR, CHAIN)).resolves.toBe(USER);
    });

    it('returns null when nothing is bound', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.resolveUser(ADDR, CHAIN)).resolves.toBeNull();
    });

    it('rejects an invalid address', async () => {
      await expect(service.resolveUser('bad', CHAIN)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('assertOwnership', () => {
    it('returns the identity for the owner', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      const identity = await service.assertOwnership(USER, ADDR, CHAIN);
      expect(identity.id).toBe('identity-uuid-1');
    });

    it('throws Forbidden for another user', async () => {
      repo.findOne.mockResolvedValue(makeIdentity({ userId: 'someone-else' }));
      await expect(service.assertOwnership(USER, ADDR, CHAIN)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFound for an unbound wallet', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.assertOwnership(USER, ADDR, CHAIN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listForUser', () => {
    it('returns the wallets bound to the user', async () => {
      repo.find.mockResolvedValue([makeIdentity()]);
      const identities = await service.listForUser(USER);
      expect(identities).toHaveLength(1);
    });

    it('rejects an empty userId', async () => {
      await expect(service.listForUser('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('unbind', () => {
    it('removes the binding for the owner', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      const removed = await service.unbind(USER, ADDR, CHAIN);
      expect(repo.remove).toHaveBeenCalled();
      expect(removed.walletAddress).toBe(ADDR.toLowerCase());
    });

    it('resolves a mixed-case address to the stored lowercase identity', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      await service.unbind(USER, ADDR.toUpperCase().replace('0X', '0x'), CHAIN);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: ADDR.toLowerCase(), chainId: CHAIN },
      });
    });

    it('throws Forbidden when another user tries to unbind', async () => {
      repo.findOne.mockResolvedValue(makeIdentity({ userId: 'someone-else' }));
      await expect(service.unbind(USER, ADDR, CHAIN)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFound for an unbound wallet', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.unbind(USER, ADDR, CHAIN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── PREWAVE-BE-060 (#653): chain context, unlink/relink policy ──────────

  describe('chain context in identity keys', () => {
    it('treats the same address on another chain as a distinct identity', async () => {
      // No binding exists on chain 1 yet; the uniqueness check is scoped to
      // (address, chain), so this bind must query chain 1 specifically.
      repo.findOne.mockResolvedValue(null);
      const result = await service.bind('user-2', ADDR, 1);
      expect(result.alreadyBound).toBe(false);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: ADDR.toLowerCase(), chainId: 1 },
      });
    });

    it('scopes lookups to the requested chain (no cross-chain resolution)', async () => {
      // A binding exists on chain 1; asking for chain 10 must fail closed
      // instead of leaking the chain-1 owner.
      repo.findOne.mockResolvedValue(null);
      await expect(service.resolveUser(ADDR, 10)).resolves.toBeNull();
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: ADDR.toLowerCase(), chainId: 10 },
      });
    });

    it('resolves mixed-case input identically on any chain', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      await expect(
        service.resolveUser('0xAABBCCDDEEFF001122334455667788990011AABB', 10),
      ).resolves.toBe(USER);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: ADDR.toLowerCase(), chainId: 10 },
      });
    });
  });

  describe('unlink policy (fail closed, revoke sessions, audit)', () => {
    it('revokes every live session for the wallet before removing the binding', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      await service.unbind(USER, ADDR, CHAIN);

      expect(authSessions.revokeAll).toHaveBeenCalledWith(ADDR.toLowerCase());
      // Safe ordering: revocation completes before the row is removed.
      expect(authSessions.revokeAll.mock.invocationCallOrder[0]).toBeLessThan(
        repo.remove.mock.invocationCallOrder[0],
      );
    });

    it('keeps the binding when session revocation fails (fail closed)', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      authSessions.revokeAll.mockRejectedValue(new Error('revocation failed'));

      await expect(service.unbind(USER, ADDR, CHAIN)).rejects.toThrow(
        'revocation failed',
      );
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('writes an audit entry for a successful unlink', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());
      await service.unbind(USER, ADDR, CHAIN);

      expect(auditTrail.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: AuditActionType.WALLET_UNLINKED,
          userId: USER,
          walletAddress: ADDR.toLowerCase(),
        }),
      );
    });

    it('does not revoke sessions or audit success for a non-owner unlink', async () => {
      repo.findOne.mockResolvedValue(makeIdentity({ userId: 'someone-else' }));

      await expect(service.unbind(USER, ADDR, CHAIN)).rejects.toThrow(
        ForbiddenException,
      );
      expect(authSessions.revokeAll).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  describe('relink (authenticated + audited)', () => {
    it('relinks with a live session bound to the exact wallet and chain', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.relink('session-token', USER, ADDR, CHAIN);

      expect(authSessions.validateForPrincipal).toHaveBeenCalledWith(
        'session-token',
        ADDR.toLowerCase(),
        CHAIN,
      );
      expect(result.alreadyBound).toBe(false);
      expect(auditTrail.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: AuditActionType.WALLET_LINKED,
          userId: USER,
          metadata: expect.objectContaining({ relink: true }),
        }),
      );
    });

    it('fails closed before any read or write when the session belongs to another wallet', async () => {
      authSessions.validateForPrincipal.mockRejectedValue(
        new UnauthorizedException('Session principal mismatch'),
      );

      await expect(
        service.relink('stolen-token', USER, ADDR, CHAIN),
      ).rejects.toThrow(UnauthorizedException);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('fails closed when the session was issued for a different chain', async () => {
      authSessions.validateForPrincipal.mockRejectedValue(
        new UnauthorizedException('Session principal mismatch'),
      );

      await expect(
        service.relink('session-token', USER, ADDR, 5),
      ).rejects.toThrow(UnauthorizedException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('audits a denied relink without masking the conflict', async () => {
      repo.findOne.mockResolvedValue(makeIdentity({ userId: 'someone-else' }));

      await expect(
        service.relink('session-token', USER, ADDR, CHAIN),
      ).rejects.toThrow(ConflictException);

      expect(auditTrail.log).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Wallet relink denied',
          metadata: expect.objectContaining({ outcome: 'denied' }),
        }),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('audits a successful relink that was already bound (idempotent owner)', async () => {
      repo.findOne.mockResolvedValue(makeIdentity());

      const result = await service.relink('session-token', USER, ADDR, CHAIN);

      expect(result.alreadyBound).toBe(true);
      expect(auditTrail.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            relink: true,
            alreadyBound: true,
          }),
        }),
      );
    });

    it('rejects malformed input before touching the session store', async () => {
      await expect(
        service.relink('session-token', USER, 'not-an-addr', CHAIN),
      ).rejects.toThrow(BadRequestException);
      expect(authSessions.validateForPrincipal).not.toHaveBeenCalled();
    });
  });
});
