import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthSessionService } from './auth-session.service';
import { AuthSession } from './entities/auth-session.entity';

const ADDR = '0xaAbBcCdDeEfF001122334455667788990011aabb';
const CHAIN = 10;

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-uuid-1',
    sessionToken: 'validtoken',
    walletAddress: ADDR.toLowerCase(),
    chainId: CHAIN,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    rotatedFromSessionId: null,
    createdAt: new Date(),
    ...overrides,
  } as AuthSession;
}

function mockRepo(overrides: Partial<any> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d) => d),
    save: jest.fn().mockImplementation((d) => Promise.resolve({ id: 'new-uuid', ...d })),
    delete: jest.fn().mockResolvedValue({ affected: 5 }),
    ...overrides,
  };
}

describe('AuthSessionService', () => {
  let service: AuthSessionService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthSessionService,
        { provide: getRepositoryToken(AuthSession), useValue: repo },
      ],
    }).compile();
    service = module.get(AuthSessionService);
  });

  describe('issue', () => {
    it('creates a session with a 128-char hex token', async () => {
      const session = await service.issue(ADDR, CHAIN);
      expect(session.sessionToken).toMatch(/^[0-9a-f]{128}$/);
    });

    it('stores the address in lowercase', async () => {
      await service.issue(ADDR, CHAIN);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: ADDR.toLowerCase() }),
      );
    });

    it('rejects invalid address', async () => {
      await expect(service.issue('not-an-addr', CHAIN)).rejects.toThrow(BadRequestException);
    });

    it('rejects chainId = 0', async () => {
      await expect(service.issue(ADDR, 0)).rejects.toThrow(BadRequestException);
    });
  });

  describe('validate', () => {
    it('returns an active session', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      const result = await service.validate('validtoken');
      expect(result.id).toBe('session-uuid-1');
    });

    it('throws for unknown token', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.validate('unknown')).rejects.toThrow(UnauthorizedException);
    });

    it('throws for revoked session', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.validate('validtoken')).rejects.toThrow(UnauthorizedException);
    });

    it('throws for expired session', async () => {
      repo.findOne.mockResolvedValue(makeSession({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.validate('validtoken')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('rotate', () => {
    it('revokes old session and returns a new one', async () => {
      const old = makeSession({ id: 'old-id', sessionToken: 'old-token' });
      repo.findOne.mockResolvedValue(old);
      const newSession = await service.rotate('old-token');
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
      expect(newSession.sessionToken).not.toBe('old-token');
      expect(newSession.rotatedFromSessionId).toBe('old-id');
    });

    it('throws if original session is already revoked', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.rotate('revoked-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('revoke', () => {
    it('sets revokedAt on the session', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      await service.revoke('validtoken');
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });

    it('throws if session already revoked', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.revoke('validtoken')).rejects.toThrow(UnauthorizedException);
    });

    it('throws if session not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.revoke('ghost')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('revokeAll', () => {
    it('revokes all active sessions for a wallet', async () => {
      repo.find.mockResolvedValue([makeSession({ id: 's1' }), makeSession({ id: 's2' })]);
      const count = await service.revokeAll(ADDR);
      expect(count).toBe(2);
      expect(repo.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ revokedAt: expect.any(Date) }),
        ]),
      );
    });

    it('returns 0 when no active sessions exist', async () => {
      repo.find.mockResolvedValue([]);
      const count = await service.revokeAll(ADDR);
      expect(count).toBe(0);
    });

    it('rejects invalid address', async () => {
      await expect(service.revokeAll('bad')).rejects.toThrow(BadRequestException);
    });
  });

  describe('pruneExpired', () => {
    it('returns affected count', async () => {
      const count = await service.pruneExpired();
      expect(count).toBe(5);
    });
  });
});