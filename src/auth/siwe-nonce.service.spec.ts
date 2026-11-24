// src/auth/siwe-nonce.service.spec.ts
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { SiweNonceService } from './siwe-nonce.service';
import * as siweModule from 'siwe';

describe('SiweNonceService (#609)', () => {
  let service: SiweNonceService;
  let dataSource: Partial<DataSource>;
  let queryRunner: Partial<QueryRunner>;

  const VALID_WALLET = '0x1111111111111111111111111111111111111111';
  const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
  const VALID_URI = 'https://truthbounty.app/login';
  const VALID_CHAIN_ID = 10; // Optimism Mainnet

  beforeEach(() => {
    delete process.env.SIWE_DOMAIN;
    delete process.env.SIWE_ALLOWED_ORIGINS;
    delete process.env.SIWE_SUPPORTED_CHAIN_IDS;

    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner as QueryRunner),
      query: jest.fn().mockResolvedValue([]),
    };

    service = new SiweNonceService(dataSource as DataSource);
  });

  describe('canonical dependency boundary', () => {
    it('uses canonical siwe generateNonce function', async () => {
      const spy = jest.spyOn(siweModule, 'generateNonce');
      const challenge = await service.issueNonceChallenge(
        VALID_WALLET,
        VALID_URI,
        VALID_CHAIN_ID,
      );

      expect(spy).toHaveBeenCalled();
      expect(challenge.nonce).toBeDefined();
      expect(challenge.nonce.length).toBeGreaterThanOrEqual(8);
      expect(challenge.siweMessage).toContain(`Nonce: ${challenge.nonce}`);
      expect(challenge.siweMessage).toContain(VALID_WALLET.toLowerCase());
      expect(challenge.siweMessage).toContain(`Chain ID: ${VALID_CHAIN_ID}`);
      expect(challenge.siweMessage).toContain(`URI: ${VALID_URI}`);
      spy.mockRestore();
    });

    it('generates an EIP-4361 compliant message structure', async () => {
      const { siweMessage } = await service.issueNonceChallenge(
        VALID_WALLET,
        VALID_URI,
        VALID_CHAIN_ID,
      );

      expect(siweMessage).toMatch(
        /truthbounty\.app wants you to sign in with your Ethereum account:\n0x1111111111111111111111111111111111111111\n\nSign in to TruthBounty V2 to verify wallet ownership\.\n\nURI: https:\/\/truthbounty\.app\/login\nVersion: 1\nChain ID: 10\nNonce: [a-zA-Z0-9]+\nIssued At: .+/,
      );
    });
  });

  describe('input validation and fail-closed security', () => {
    it('rejects invalid EVM wallet address', async () => {
      await expect(
        service.issueNonceChallenge('not-an-address', VALID_URI, VALID_CHAIN_ID),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.issueNonceChallenge('0x123', VALID_URI, VALID_CHAIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed URI', async () => {
      await expect(
        service.issueNonceChallenge(VALID_WALLET, 'not a url', VALID_CHAIN_ID),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.issueNonceChallenge(VALID_WALLET, '', VALID_CHAIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unsupported chain ID', async () => {
      await expect(
        service.issueNonceChallenge(VALID_WALLET, VALID_URI, 0),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.issueNonceChallenge(VALID_WALLET, VALID_URI, -1),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.issueNonceChallenge(VALID_WALLET, VALID_URI, 999999),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects origin when SIWE_ALLOWED_ORIGINS is configured and does not match', async () => {
      process.env.SIWE_ALLOWED_ORIGINS = 'https://app.truthbounty.com';
      const restrictedService = new SiweNonceService(dataSource as DataSource);

      await expect(
        restrictedService.issueNonceChallenge(
          VALID_WALLET,
          'https://attacker.site/callback',
          VALID_CHAIN_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('consumeNonce (race-safe atomic one-time consumption)', () => {
    const NONCE = 'abc123def456';

    it('succeeds when atomic conditional update modifies 1 row', async () => {
      (dataSource.query as jest.Mock).mockResolvedValueOnce([{ id: 1 }]);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).resolves.toBeUndefined();

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "v2_auth_nonces" SET "used" = TRUE'),
        [VALID_WALLET.toLowerCase(), NONCE, expect.any(Date)],
      );
    });

    it('rejects when nonce is already used (replay attack prevented)', async () => {
      // 0 rows updated
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        // Diagnostic query finds record already used
        .mockResolvedValueOnce([
          {
            id: 1,
            wallet_address: VALID_WALLET.toLowerCase(),
            nonce: NONCE,
            expires_at: new Date(Date.now() + 60_000),
            used: true,
          },
        ]);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow('replay attack prevented');
    });

    it('rejects when nonce has expired', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 1,
            wallet_address: VALID_WALLET.toLowerCase(),
            nonce: NONCE,
            expires_at: new Date(Date.now() - 60_000), // in the past
            used: false,
          },
        ]);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow('expired');
    });

    it('rejects when nonce is bound to a different wallet', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 1,
            wallet_address: OTHER_WALLET.toLowerCase(),
            nonce: NONCE,
            expires_at: new Date(Date.now() + 60_000),
            used: false,
          },
        ]);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow('binding mismatch');
    });

    it('rejects unknown nonce', async () => {
      (dataSource.query as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]); // no record found

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.consumeNonce(VALID_WALLET, NONCE),
      ).rejects.toThrow('Invalid or unknown nonce');
    });

    it('guarantees mutual exclusion under concurrent consume requests', async () => {
      // Simulate two concurrent requests arriving with the same valid nonce.
      // Database executes atomic UPDATE for both.
      // First one gets [{ id: 1 }] (1 row updated)
      // Second one gets [] (0 rows updated) because 'used' is now true.
      let firstCall = true;
      (dataSource.query as jest.Mock).mockImplementation((sql: string) => {
        if (sql.includes('UPDATE "v2_auth_nonces"')) {
          if (firstCall) {
            firstCall = false;
            return Promise.resolve([{ id: 1 }]);
          }
          return Promise.resolve([]);
        }
        if (sql.includes('SELECT "id"')) {
          return Promise.resolve([
            {
              id: 1,
              wallet_address: VALID_WALLET.toLowerCase(),
              nonce: NONCE,
              expires_at: new Date(Date.now() + 60_000),
              used: true,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const call1 = service.consumeNonce(VALID_WALLET, NONCE);
      const call2 = service.consumeNonce(VALID_WALLET, NONCE);

      const results = await Promise.allSettled([call1, call2]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      if (results[1].status === 'rejected') {
        expect(results[1].reason).toBeInstanceOf(UnauthorizedException);
        expect(results[1].reason.message).toContain('replay attack prevented');
      }
    });

    it('rejects malformed nonce inputs on consumption', async () => {
      await expect(
        service.consumeNonce(VALID_WALLET, ''),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.consumeNonce(VALID_WALLET, 'short'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.consumeNonce(VALID_WALLET, 'invalid-symbols!@#$'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('confidentiality constraints', () => {
    it('never logs private keys, seeds, or signature material', async () => {
      const loggerLogSpy = jest.spyOn(service['logger'], 'log');
      const loggerErrorSpy = jest.spyOn(service['logger'], 'error');

      await service.issueNonceChallenge(VALID_WALLET, VALID_URI, VALID_CHAIN_ID);
      (dataSource.query as jest.Mock).mockResolvedValueOnce([{ id: 1 }]);
      await service.consumeNonce(VALID_WALLET, 'validNonce123456');

      const allLogs = [
        ...loggerLogSpy.mock.calls.map((c) => String(c[0])),
        ...loggerErrorSpy.mock.calls.map((c) => String(c[0])),
      ].join(' ');

      expect(allLogs).not.toMatch(/private[_-]?key/i);
      expect(allLogs).not.toMatch(/seed/i);
      expect(allLogs).not.toMatch(/signature/i);
      expect(allLogs).not.toMatch(/secret/i);
    });
  });
});
