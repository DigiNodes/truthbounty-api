import { createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { AuthSessionService } from './auth-session.service';
import { AuthSession } from './entities/auth-session.entity';

const ADDR = '0xaAbBcCdDeEfF001122334455667788990011aabb';
const CHAIN = 10;

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    id: 'session-uuid-1',
    tokenHash: 'a'.repeat(64),
    walletAddress: ADDR.toLowerCase(),
    chainId: CHAIN,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    rotatedFromSessionId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

interface MockRepo {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
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
    delete: jest.fn().mockResolvedValue({ affected: 5 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    ...overrides,
  };
}

/**
 * Runs the transaction callback against the same mock repository, so the
 * transactional path is exercised rather than skipped.
 */
function mockDataSource(repo: MockRepo) {
  return {
    transaction: jest.fn(
      (run: (manager: { getRepository: () => MockRepo }) => Promise<unknown>) =>
        run({ getRepository: () => repo }),
    ),
  };
}

describe('AuthSessionService', () => {
  let service: AuthSessionService;
  let repo: MockRepo;
  let dataSource: ReturnType<typeof mockDataSource>;

  beforeEach(async () => {
    repo = mockRepo();
    dataSource = mockDataSource(repo);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthSessionService,
        { provide: getRepositoryToken(AuthSession), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(AuthSessionService);
  });

  describe('issue', () => {
    it('returns a 128-char hex token', async () => {
      const { sessionToken } = await service.issue(ADDR, CHAIN);
      expect(sessionToken).toMatch(/^[0-9a-f]{128}$/);
    });

    it('persists the digest of the token and never the token itself', async () => {
      const { sessionToken } = await service.issue(ADDR, CHAIN);
      const digest = createHash('sha256').update(sessionToken).digest('hex');

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: digest }),
      );
      // The persisted row must not contain the bearer token itself.
      const [created] = repo.create.mock.calls as [[Record<string, unknown>]];
      expect(JSON.stringify(created)).not.toContain(sessionToken);
      expect(digest).toHaveLength(64);
    });

    it('stores the address in lowercase', async () => {
      await service.issue(ADDR, CHAIN);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: ADDR.toLowerCase() }),
      );
    });

    it('rejects invalid address', async () => {
      await expect(service.issue('not-an-addr', CHAIN)).rejects.toThrow(
        BadRequestException,
      );
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

    it('looks the session up by token digest, not by raw token', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      await service.validate('validtoken');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: {
          tokenHash: createHash('sha256').update('validtoken').digest('hex'),
        },
      });
    });

    it('rejects an empty token before querying', async () => {
      await expect(service.validate('')).rejects.toThrow(UnauthorizedException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('rejects a missing token before querying', async () => {
      await expect(
        service.validate(undefined as unknown as string),
      ).rejects.toThrow(UnauthorizedException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('throws for unknown token', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.validate('unknown')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws for revoked session', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.validate('validtoken')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws for expired session', async () => {
      repo.findOne.mockResolvedValue(
        makeSession({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.validate('validtoken')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('validateForPrincipal (PREWAVE-BE-060)', () => {
    it('accepts a session presented for its own wallet and chain', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      const session = await service.validateForPrincipal(
        'validtoken',
        ADDR,
        CHAIN,
      );
      expect(session.id).toBe('session-uuid-1');
    });

    it('accepts a mixed-case address for the bound lowercase principal', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      await expect(
        service.validateForPrincipal('validtoken', ADDR.toUpperCase(), CHAIN),
      ).resolves.toBeDefined();
    });

    it('fails closed when the session was issued for a different wallet', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      const otherWallet = '0x0000000000000000000000000000000000000001';
      await expect(
        service.validateForPrincipal('validtoken', otherWallet, CHAIN),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('fails closed when the session was issued for a different chain', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      await expect(
        service.validateForPrincipal('validtoken', ADDR, 1),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('propagates revocation and expiry failures from validate', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(
        service.validateForPrincipal('validtoken', ADDR, CHAIN),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('rotate', () => {
    it('revokes the old session and returns a new one', async () => {
      const old = makeSession({ id: 'old-id', tokenHash: 'old-hash' });
      repo.findOne.mockResolvedValue(old);

      const { sessionToken, session } = await service.rotate('old-token');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'old-id', revokedAt: IsNull() },
        { revokedAt: anyDate() },
      );
      expect(sessionToken).not.toBe('old-hash');
      expect(session.rotatedFromSessionId).toBe('old-id');
    });

    it('runs both writes in a single transaction', async () => {
      repo.findOne.mockResolvedValue(makeSession({ id: 'old-id' }));
      await service.rotate('old-token');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('persists the new token as a digest, not in the clear', async () => {
      repo.findOne.mockResolvedValue(makeSession({ id: 'old-id' }));
      const { sessionToken } = await service.rotate('old-token');
      const digest = createHash('sha256').update(sessionToken).digest('hex');

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: digest }),
      );
    });

    it('cannot change principal: the successor inherits wallet and chain', async () => {
      repo.findOne.mockResolvedValue(makeSession({ id: 'old-id' }));

      await service.rotate('old-token');

      // Rotation carries no principal parameters; the new row must copy the
      // wallet+chain of the revoked one (PREWAVE-BE-060).
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: ADDR.toLowerCase(),
          chainId: CHAIN,
        }),
      );
    });

    it('fails closed when the session was rotated concurrently', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      // A competing rotation already revoked the row, so this UPDATE matches
      // nothing and the whole transaction must abort.
      repo.update.mockResolvedValue({ affected: 0 });

      await expect(service.rotate('validtoken')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws if original session is already revoked', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.rotate('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('revoke', () => {
    it('sets revokedAt on the session', async () => {
      repo.findOne.mockResolvedValue(makeSession());
      await service.revoke('validtoken');
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: anyDate() }),
      );
    });

    it('rejects an empty token before querying', async () => {
      await expect(service.revoke('')).rejects.toThrow(UnauthorizedException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('throws if session already revoked', async () => {
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.revoke('validtoken')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws if session not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.revoke('ghost')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('revokeAll', () => {
    it('revokes all active sessions for a wallet', async () => {
      repo.find.mockResolvedValue([
        makeSession({ id: 's1' }),
        makeSession({ id: 's2' }),
      ]);
      const count = await service.revokeAll(ADDR);
      expect(count).toBe(2);
      expect(repo.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ revokedAt: anyDate() }),
        ]),
      );
    });

    it('returns 0 when no active sessions exist', async () => {
      repo.find.mockResolvedValue([]);
      const count = await service.revokeAll(ADDR);
      expect(count).toBe(0);
    });

    it('rejects invalid address', async () => {
      await expect(service.revokeAll('bad')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('pruneExpired', () => {
    it('returns affected count', async () => {
      const count = await service.pruneExpired();
      expect(count).toBe(5);
    });
  });

  // ── PREWAVE-BE-060 (#653): session theft containment ─────────────────────

  describe('session theft fixture', () => {
    it("lets the owner revoke every session, killing the thief's token", async () => {
      // Owner authenticates and issues two sessions; the attacker steals one.
      const { sessionToken: stolen } = await service.issue(ADDR, CHAIN);
      await service.issue(ADDR, CHAIN);

      // While active, the stolen token validates — theft is possible; what
      // matters is containment after the owner reacts.
      repo.findOne.mockResolvedValue(makeSession());
      await expect(service.validate(stolen)).resolves.toBeDefined();

      // Owner forces a global logout for the wallet.
      repo.find.mockResolvedValue([makeSession({ id: 's1' })]);
      await service.revokeAll(ADDR);
      expect(repo.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ revokedAt: anyDate() }),
        ]),
      );

      // The thief's token now fails closed.
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.validate(stolen)).rejects.toThrow(
        UnauthorizedException,
      );
      // …and cannot be rotated either.
      await expect(service.rotate(stolen)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a rotated-away token is dead even if the thief still holds it', async () => {
      repo.findOne.mockResolvedValue(makeSession({ id: 'old-id' }));
      await service.rotate('old-token');

      // The thief replays the old token: its row is revoked, so validation
      // and rotation both fail closed.
      repo.findOne.mockResolvedValue(makeSession({ revokedAt: new Date() }));
      await expect(service.validate('old-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.rotate('old-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

/**
 * `expect.any(Date)` is typed `any`, which trips the repo's strict
 * no-unsafe-assignment rule when it is used as an object property value.
 */
function anyDate(): Date {
  return expect.any(Date) as Date;
}
