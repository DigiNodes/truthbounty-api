import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WalletIdentityService } from './wallet-identity.service';
import { WalletIdentity } from './entities/wallet-identity.entity';

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

  beforeEach(async () => {
    repo = mockRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletIdentityService,
        { provide: getRepositoryToken(WalletIdentity), useValue: repo },
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
      repo.save.mockRejectedValue({ driverError: { code: '23505' } });
      await expect(service.bind(USER, ADDR, CHAIN)).rejects.toThrow(
        ConflictException,
      );
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
});
