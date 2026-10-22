import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SafeHttpClientService } from '../../common/security/ssrf';
import { WorldcoinService } from './worldcoin.service';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { PrismaService } from '../../prisma/prisma.service';
import { SybilResistanceService } from '../../sybil-resistance/sybil-resistance.service';

// Prevent native @libsql binaries from loading during unit tests
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));
jest.mock('../../sybil-resistance/sybil-resistance.service', () => ({
  SybilResistanceService: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_ACTION = 'test-action';
const VALID_APP_ID = 'test-app-id';
const VALID_BASE_URL = 'https://developer.worldcoin.org/api/v2/verify';

const VALID_PROOF = {
  merkle_root: '0xdeadbeef',
  nullifier_hash: '0xcafe1234',
  proof: '0xabc123',
  verification_level: 'orb',
} as const;

const VALID_DTO = {
  proof: { ...VALID_PROOF },
  action: VALID_ACTION,
  signal: 'test-signal',
};

/** Returns an HTTP-response-like mock for the SSRF-safe client. */
function makeOkResponse(body: object = { success: true }): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockReturnValue(body),
  } as unknown as Response;
}

function makeErrorResponse(status = 400): Response {
  return {
    ok: false,
    status,
    json: jest.fn().mockReturnValue({ detail: 'verification_error' }),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Module bootstrap
// ---------------------------------------------------------------------------

describe('WorldcoinService', () => {
  let service: WorldcoinService;
  let httpPostMock: jest.Mock;
  let repository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let configMap: Record<string, string | number | undefined>;
  let prisma: {
    $transaction: jest.Mock;
    worldIdVerification: { findUnique: jest.Mock; findFirst: jest.Mock };
    user: { update: jest.Mock };
  };
  let sybilResistanceService: { recordSybilScore: jest.Mock };

  beforeEach(async () => {
    repository = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };

    configMap = {
      WORLDCOIN_APP_ID: VALID_APP_ID,
      WORLDCOIN_ACTION: VALID_ACTION,
      WORLDCOIN_VERIFY_BASE_URL: VALID_BASE_URL,
    };

    prisma = {
      $transaction: jest.fn(),
      worldIdVerification: { findUnique: jest.fn(), findFirst: jest.fn() },
      user: { update: jest.fn() },
    };

    sybilResistanceService = { recordSybilScore: jest.fn() };

    // Default transaction: check passes (no existing), create + user update succeed.
    prisma.$transaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const txPrisma = {
          worldIdVerification: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
          },
          user: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma as unknown as typeof prisma);
      },
    );

    const mockVerification: Partial<WorldIdVerification> = {
      id: 'ver-1',
      userId: 'user-1',
      nullifierHash: VALID_PROOF.nullifier_hash,
      verificationLevel: VALID_PROOF.verification_level,
      worldcoinAppId: VALID_APP_ID,
      worldcoinAction: VALID_ACTION,
      verifiedAt: new Date(),
    };

    repository.create.mockReturnValue(mockVerification);
    repository.save.mockResolvedValue(mockVerification);
    sybilResistanceService.recordSybilScore.mockResolvedValue({
      compositeScore: 0.5,
    });

    httpPostMock = jest.fn().mockResolvedValue(makeOkResponse());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorldcoinService,
        {
          provide: getRepositoryToken(WorldIdVerification),
          useValue: repository,
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => configMap[key] },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: SybilResistanceService, useValue: sybilResistanceService },
        { provide: SafeHttpClientService, useValue: { post: httpPostMock } },
      ],
    }).compile();

    service = module.get<WorldcoinService>(WorldcoinService);
  });

  afterEach(() => jest.clearAllMocks());

  // =========================================================================
  // 1. Happy path
  // =========================================================================

  describe('happy path', () => {
    it('verifies a valid proof and returns a WorldIdVerification record', async () => {
      const result = await service.verifyProof('user-1', VALID_DTO);

      expect(result.userId).toBe('user-1');
      expect(result.nullifierHash).toBe(VALID_PROOF.nullifier_hash);
      expect(httpPostMock).toHaveBeenCalledTimes(1);
    });

    it('passes the correct fields to the provider, including signal', async () => {
      await service.verifyProof('user-1', VALID_DTO);

      const [url, rawBody] = httpPostMock.mock.calls[0] as [string, string];
      expect(url).toBe(`${VALID_BASE_URL}/${VALID_APP_ID}`);
      const body = JSON.parse(rawBody);
      expect(body.action).toBe(VALID_ACTION);
      expect(body.signal).toBe('test-signal');
      expect(body.merkle_root).toBe(VALID_PROOF.merkle_root);
    });

    it('omits signal key when signal is undefined', async () => {
      const dto = { ...VALID_DTO, signal: undefined };
      await service.verifyProof('user-1', dto);

      const [, rawBody] = httpPostMock.mock.calls[0] as [string, string];
      const body = JSON.parse(rawBody);
      expect(Object.prototype.hasOwnProperty.call(body, 'signal')).toBe(false);
    });

    it('does NOT store raw proof bytes in the TypeORM entity', async () => {
      await service.verifyProof('user-1', VALID_DTO);

      const createArg = repository.create.mock
        .calls[0][0] as Partial<WorldIdVerification>;
      expect(createArg).not.toHaveProperty('proof');
    });

    it('does NOT store raw proof bytes in the Prisma transaction create', async () => {
      let txCreateArg: Record<string, unknown> | undefined;
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockImplementation((arg: unknown) => {
                txCreateArg = arg as Record<string, unknown>;
                return Promise.resolve({});
              }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await service.verifyProof('user-1', VALID_DTO);

      expect(txCreateArg).toBeDefined();
      const data =
        (txCreateArg as { data?: Record<string, unknown> }).data ?? {};
      expect(data).not.toHaveProperty('proof');
    });

    it('calls recordSybilScore after successful verification', async () => {
      await service.verifyProof('user-1', VALID_DTO);
      expect(sybilResistanceService.recordSybilScore).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('marks user worldcoinVerified=true inside the transaction', async () => {
      let userUpdateArg: unknown;
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue({}),
            },
            user: {
              update: jest.fn().mockImplementation((arg: unknown) => {
                userUpdateArg = arg;
                return Promise.resolve({});
              }),
            },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await service.verifyProof('user-1', VALID_DTO);

      expect(userUpdateArg).toMatchObject({
        where: { id: 'user-1' },
        data: { worldcoinVerified: true },
      });
    });
  });

  // =========================================================================
  // 2. Wrong action (required test scenario #1)
  // =========================================================================

  describe('wrong action', () => {
    it('throws BadRequestException when action does not match config', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, action: 'wrong-action' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT contact the provider when action is wrong', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, action: 'evil-action' }),
      ).rejects.toThrow(BadRequestException);

      expect(httpPostMock).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when action is an empty string', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, action: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ServiceUnavailableException when WORLDCOIN_ACTION is not configured', async () => {
      configMap['WORLDCOIN_ACTION'] = undefined;
      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // =========================================================================
  // 3. Wrong / invalid signal (required test scenario #2)
  // =========================================================================

  describe('wrong / invalid signal', () => {
    it('throws BadRequestException for an empty signal string', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, signal: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a whitespace-only signal', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, signal: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when signal exceeds 512 characters', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          signal: 'x'.repeat(513),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not contact the provider when signal is invalid', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, signal: '' }),
      ).rejects.toThrow(BadRequestException);
      expect(httpPostMock).not.toHaveBeenCalled();
    });

    it('accepts undefined signal (signal is optional)', async () => {
      await expect(
        service.verifyProof('user-1', { ...VALID_DTO, signal: undefined }),
      ).resolves.toBeDefined();
    });

    it('accepts a valid 512-character signal', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          signal: 'a'.repeat(512),
        }),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // 4. Reused nullifier — transactional uniqueness (required test scenario #3)
  // =========================================================================

  describe('reused nullifier', () => {
    it('throws ConflictException when nullifier is already in Prisma store', async () => {
      // Simulate the transaction finding an existing record.
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue({
                id: 'existing',
                nullifierHash: VALID_PROOF.nullifier_hash,
              }),
              create: jest.fn(),
            },
            user: { update: jest.fn() },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ConflictException,
      );
    });

    it('does NOT write a new Prisma record when nullifier is already used', async () => {
      let txCreateCalled = false;
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
              create: jest.fn().mockImplementation(() => {
                txCreateCalled = true;
                return Promise.resolve({});
              }),
            },
            user: { update: jest.fn() },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ConflictException,
      );
      expect(txCreateCalled).toBe(false);
    });

    it('uniqueness check is inside a transaction (atomic TOCTOU guard)', () => {
      // The $transaction mock is called exactly once per verifyProof call,
      // proving the check and insert are collocated in a single transaction
      // rather than two separate DB calls.
      const txCalls: unknown[] = [];
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          txCalls.push(fn);
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockResolvedValue({}),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      return service.verifyProof('user-1', VALID_DTO).then(() => {
        expect(txCalls).toHaveLength(1);
      });
    });
  });

  // =========================================================================
  // 5. Stale / malformed root (required test scenario #4)
  // =========================================================================

  describe('malformed / invalid proof fields', () => {
    it('throws BadRequestException for a non-hex merkle_root', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          proof: { ...VALID_PROOF, merkle_root: 'not-hex' },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(httpPostMock).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an empty merkle_root', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          proof: { ...VALID_PROOF, merkle_root: '' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a non-hex nullifier_hash', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          proof: { ...VALID_PROOF, nullifier_hash: 'plaintext-hash' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a non-hex proof string', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          proof: { ...VALID_PROOF, proof: 'not-a-hex-proof' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for an unknown verification_level', async () => {
      await expect(
        service.verifyProof('user-1', {
          ...VALID_DTO,
          proof: { ...VALID_PROOF, verification_level: 'ultraorb' },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT contact the provider for any malformed proof field', async () => {
      const badProofs = [
        { ...VALID_PROOF, merkle_root: 'bad' },
        { ...VALID_PROOF, nullifier_hash: 'bad' },
        { ...VALID_PROOF, proof: 'bad' },
        { ...VALID_PROOF, verification_level: 'unknown' },
      ];

      for (const badProof of badProofs) {
        httpPostMock.mockClear();
        await expect(
          service.verifyProof('user-1', { ...VALID_DTO, proof: badProof }),
        ).rejects.toThrow(BadRequestException);
        expect(httpPostMock).not.toHaveBeenCalled();
      }
    });
  });

  // =========================================================================
  // 6. Provider outage (required test scenario #5)
  // =========================================================================

  describe('provider outage', () => {
    it('throws ServiceUnavailableException on network error (not BadRequestException)', async () => {
      httpPostMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws ServiceUnavailableException on DNS failure', async () => {
      httpPostMock.mockRejectedValue(
        new Error('ENOTFOUND developer.worldcoin.org'),
      );

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('does NOT persist a verification record when provider is unreachable', async () => {
      httpPostMock.mockRejectedValue(new Error('timeout'));

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('throws ServiceUnavailableException when provider returns malformed JSON', async () => {
      httpPostMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockImplementation(() => {
          throw new SyntaxError('Unexpected token');
        }),
      } as unknown as Response);

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws BadRequestException (not ServiceUnavailable) when provider rejects proof (4xx)', async () => {
      httpPostMock.mockResolvedValue(makeErrorResponse(400));

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when provider returns success: false', async () => {
      httpPostMock.mockResolvedValue(makeOkResponse({ success: false }));

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ServiceUnavailableException when WORLDCOIN_APP_ID is not configured', async () => {
      configMap['WORLDCOIN_APP_ID'] = undefined;

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // =========================================================================
  // 7. Privacy / proof retention (required test scenario #6)
  // =========================================================================

  describe('proof data retention and privacy logging', () => {
    it('does not include raw proof in any log output (logger.log / logger.warn / logger.error)', async () => {
      // Spy on the internal logger to verify no raw proof bytes are emitted.
      // We access the logger through the service instance.

      const svc = service as any;
      const logSpy = jest
        .spyOn(svc.logger, 'log')
        .mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(svc.logger, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(svc.logger, 'error')
        .mockImplementation(() => undefined);

      await service.verifyProof('user-1', VALID_DTO);

      const allLogMessages = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .map((v) => String(v));

      for (const msg of allLogMessages) {
        // Raw proof bytes must never appear in any log line.
        expect(msg).not.toContain(VALID_PROOF.proof);
        // Nullifier hash must not appear in success log paths.
        expect(msg).not.toContain(VALID_PROOF.nullifier_hash);
      }
    });

    it('logs [redacted] placeholder (not raw hash) on nullifier replay attempt', async () => {
      const svc = service as any;
      const warnSpy = jest
        .spyOn(svc.logger, 'warn')
        .mockImplementation(() => undefined);

      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
              create: jest.fn(),
            },
            user: { update: jest.fn() },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await expect(service.verifyProof('user-1', VALID_DTO)).rejects.toThrow(
        ConflictException,
      );

      const warnMessages = warnSpy.mock.calls.flat().map(String);
      // Should contain a redacted marker, not the actual nullifier hash.
      expect(warnMessages.some((m) => m.includes('[redacted]'))).toBe(true);
      // Must not log the actual nullifier value.
      for (const msg of warnMessages) {
        expect(msg).not.toContain(VALID_PROOF.nullifier_hash);
      }
    });

    it('does not store raw proof bytes — only proofHash is in the entity', async () => {
      await service.verifyProof('user-1', VALID_DTO);

      const createArg = repository.create.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(createArg).not.toHaveProperty('proof');
      // proofHash is set internally; the raw proof field must be absent.
      expect(JSON.stringify(createArg)).not.toContain(VALID_PROOF.proof);
    });

    it('does not store raw proof bytes in Prisma create data', async () => {
      let createData: Record<string, unknown> | undefined;
      prisma.$transaction.mockImplementation(
        async (fn: (tx: typeof prisma) => Promise<unknown>) => {
          const txPrisma = {
            worldIdVerification: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest
                .fn()
                .mockImplementation(
                  (arg: { data: Record<string, unknown> }) => {
                    createData = arg.data;
                    return Promise.resolve({});
                  },
                ),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
          };
          return fn(txPrisma as unknown as typeof prisma);
        },
      );

      await service.verifyProof('user-1', VALID_DTO);

      expect(createData).toBeDefined();
      expect(createData!).not.toHaveProperty('proof');
      expect(JSON.stringify(createData)).not.toContain(VALID_PROOF.proof);
    });

    it('does not expose raw proof in getVerificationByNullifierHash response', async () => {
      const stored: Partial<WorldIdVerification> = {
        id: 'ver-1',
        userId: 'user-1',
        nullifierHash: '0xcafe1234',
        verificationLevel: 'orb',
        verifiedAt: new Date(),
        // proofHash stored internally, but the TypeORM entity no longer has
        // a `proof` column — raw bytes are not retrievable.
      };
      repository.findOne.mockResolvedValue(stored);

      const result = await service.getVerificationByNullifierHash('0xcafe1234');

      expect(result).toBeDefined();
      // The result must not carry raw proof bytes.
      expect(
        (result as unknown as Record<string, unknown>)['proof'],
      ).toBeUndefined();
    });
  });

  // =========================================================================
  // 8. Legacy query helpers (backward compatibility)
  // =========================================================================

  describe('getVerificationStatus', () => {
    it('returns the most recent verification for a user', async () => {
      const mock: Partial<WorldIdVerification> = {
        id: 'ver-1',
        userId: 'user-1',
        verificationLevel: 'orb',
        verifiedAt: new Date(),
      };
      repository.findOne.mockResolvedValue(mock);

      const result = await service.getVerificationStatus('user-1');
      expect(result).toEqual(mock);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { verifiedAt: 'DESC' },
      });
    });

    it('returns null when no verification exists', async () => {
      repository.findOne.mockResolvedValue(null);
      const result = await service.getVerificationStatus('user-1');
      expect(result).toBeNull();
    });
  });

  describe('isUserVerified', () => {
    it('returns true when TypeORM store has a record', async () => {
      repository.findOne.mockResolvedValue({ id: 'v1' } as WorldIdVerification);
      prisma.worldIdVerification.findFirst.mockResolvedValue(null);

      expect(await service.isUserVerified('user-1')).toBe(true);
    });

    it('returns true when Prisma store has a record', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findFirst.mockResolvedValue({ id: 'v2' });

      expect(await service.isUserVerified('user-1')).toBe(true);
    });

    it('returns false when neither store has a record', async () => {
      repository.findOne.mockResolvedValue(null);
      prisma.worldIdVerification.findFirst.mockResolvedValue(null);

      expect(await service.isUserVerified('user-1')).toBe(false);
    });
  });
});
