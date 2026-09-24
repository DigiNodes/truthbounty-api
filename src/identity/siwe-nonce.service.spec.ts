import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SiweNonceService } from './siwe-nonce.service';
import { SiweNonce } from './entities/siwe-nonce.entity';

const ADDR = '0xaAbBcCdDeEfF001122334455667788990011aabb';
const DOMAIN = 'truthbounty.io';
const CHAIN = 10;

function makeRecord(overrides: Partial<SiweNonce> = {}): SiweNonce {
  return {
    id: 'uuid-1',
    nonce: 'abc123',
    address: ADDR.toLowerCase(),
    domain: DOMAIN,
    chainId: CHAIN,
    isConsumed: false,
    expiresAt: new Date(Date.now() + 60_000),
    issuedAt: new Date(),
    ...overrides,
  };
}

interface MockRepo {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
}

function mockRepo(overrides: Partial<MockRepo> = {}): MockRepo {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) => input),
    save: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(input),
      ),
    delete: jest.fn().mockResolvedValue({ affected: 3 }),
    ...overrides,
  };
}

describe('SiweNonceService', () => {
  let service: SiweNonceService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SiweNonceService,
        { provide: getRepositoryToken(SiweNonce), useValue: repo },
      ],
    }).compile();
    service = module.get(SiweNonceService);
  });

  describe('issue', () => {
    it('returns a 64-char hex nonce', async () => {
      const nonce = await service.issue(ADDR, DOMAIN, CHAIN);
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects an invalid address', async () => {
      await expect(service.issue('bad', DOMAIN, CHAIN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an empty domain', async () => {
      await expect(service.issue(ADDR, '', CHAIN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects chainId = 0', async () => {
      await expect(service.issue(ADDR, DOMAIN, 0)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('verifyAndConsume', () => {
    it('succeeds with valid bound nonce', async () => {
      repo.findOne.mockResolvedValue(makeRecord({ nonce: 'valid-nonce' }));
      await expect(
        service.verifyAndConsume({
          nonce: 'valid-nonce',
          address: ADDR,
          domain: DOMAIN,
          chainId: CHAIN,
        }),
      ).resolves.toBeUndefined();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isConsumed: true }),
      );
    });

    it('rejects unknown nonce', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.verifyAndConsume({
          nonce: 'unknown',
          address: ADDR,
          domain: DOMAIN,
          chainId: CHAIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects already-consumed nonce', async () => {
      repo.findOne.mockResolvedValue(makeRecord({ isConsumed: true }));
      await expect(
        service.verifyAndConsume({
          nonce: 'used',
          address: ADDR,
          domain: DOMAIN,
          chainId: CHAIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects expired nonce', async () => {
      repo.findOne.mockResolvedValue(
        makeRecord({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(
        service.verifyAndConsume({
          nonce: 'expired',
          address: ADDR,
          domain: DOMAIN,
          chainId: CHAIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects address binding mismatch', async () => {
      repo.findOne.mockResolvedValue(makeRecord());
      await expect(
        service.verifyAndConsume({
          nonce: 'x',
          address: '0x0000000000000000000000000000000000000001',
          domain: DOMAIN,
          chainId: CHAIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects domain binding mismatch', async () => {
      repo.findOne.mockResolvedValue(makeRecord());
      await expect(
        service.verifyAndConsume({
          nonce: 'x',
          address: ADDR,
          domain: 'evil.io',
          chainId: CHAIN,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects chainId binding mismatch', async () => {
      repo.findOne.mockResolvedValue(makeRecord());
      await expect(
        service.verifyAndConsume({
          nonce: 'x',
          address: ADDR,
          domain: DOMAIN,
          chainId: 1,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('pruneExpired', () => {
    it('returns affected count', async () => {
      const count = await service.pruneExpired();
      expect(count).toBe(3);
    });
  });
});
