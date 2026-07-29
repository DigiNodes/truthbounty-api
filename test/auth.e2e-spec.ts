import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ethers } from 'ethers';

describe('Authentication Gateway E2E (auth.e2e-spec.ts)', () => {
  let app: INestApplication;
  let testWallet: ethers.Wallet;

  beforeAll(async () => {
    testWallet = ethers.Wallet.createRandom();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── POST /auth/challenge ─────────────────────────────────────────────────

  describe('POST /auth/challenge', () => {
    it('should return a legacy challenge message by default', () => {
      return request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address })
        .expect(201)
        .expect((res) => {
          expect(res.body.message).toContain('Sign in to TruthBounty:');
          expect(res.body.format).toBe('legacy');
          expect(res.body.address).toBe(testWallet.address);
        });
    });

    it('should return a SIWE message when domain is provided', () => {
      return request(app.getHttpServer())
        .post('/auth/challenge')
        .send({
          address: testWallet.address,
          domain: 'app.truthbounty.com',
          uri: 'https://app.truthbounty.com',
          chainId: 1,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.message).toContain('wants you to sign in with your Ethereum account');
          expect(res.body.format).toBe('siwe');
        });
    });

    it('should reject invalid address format', () => {
      return request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: 'invalid-address' })
        .expect(400);
    });
  });

  // ── POST /auth/login ─────────────────────────────────────────────────────

  describe('POST /auth/login', () => {
    let challengeMessage: string;

    beforeEach(async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address });
      challengeMessage = challengeRes.body.message;
    });

    it('should login and return access + refresh tokens', async () => {
      const signature = await testWallet.signMessage(challengeMessage);

      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeMessage,
        })
        .expect(201)
        .expect((res) => {
          expect(res.body.accessToken).toBeDefined();
          expect(res.body.refreshToken).toBeDefined();
          expect(res.body.expiresIn).toBeGreaterThan(0);
          expect(res.body.user.address).toBe(testWallet.address.toLowerCase());
        });
    });

    it('should reject invalid signature format', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature: '0xinvalid',
          message: challengeMessage,
        })
        .expect(400);
    });

    it('should reject mismatched address', async () => {
      const signature = await testWallet.signMessage(challengeMessage);
      const wrongWallet = ethers.Wallet.createRandom();

      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: wrongWallet.address,
          signature,
          message: challengeMessage,
        })
        .expect(401);
    });

    it('should reject reused nonce (replay prevention)', async () => {
      const signature = await testWallet.signMessage(challengeMessage);

      // First login succeeds
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeMessage,
        })
        .expect(201);

      // Second login with same challenge fails
      const signature2 = await testWallet.signMessage(challengeMessage);
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature: signature2,
          message: challengeMessage,
        })
        .expect(401);
    });
  });

  // ── POST /auth/refresh ───────────────────────────────────────────────────

  describe('POST /auth/refresh', () => {
    let refreshToken: string;

    beforeAll(async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address });

      const signature = await testWallet.signMessage(challengeRes.body.message);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeRes.body.message,
        });

      refreshToken = loginRes.body.refreshToken;
    });

    it('should refresh and return new token pair', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(200)
        .expect((res) => {
          expect(res.body.accessToken).toBeDefined();
          expect(res.body.refreshToken).toBeDefined();
          expect(res.body.expiresIn).toBeGreaterThan(0);
        });
    });

    it('should reject malformed refresh token', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'bad-format' })
        .expect(401);
    });

    it('should reject invalid refresh token', () => {
      return request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'fakejti.faketokenvalue' })
        .expect(401);
    });
  });

  // ── POST /auth/logout ────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    let accessToken: string;

    beforeAll(async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address });

      const signature = await testWallet.signMessage(challengeRes.body.message);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeRes.body.message,
        });

      accessToken = loginRes.body.accessToken;
    });

    it('should logout successfully with valid token', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBe('Logged out successfully');
        });
    });

    it('should reject logout without token', () => {
      return request(app.getHttpServer())
        .post('/auth/logout')
        .expect(403);
    });
  });

  // ── GET /auth/profile ────────────────────────────────────────────────────

  describe('GET /auth/profile', () => {
    let accessToken: string;

    beforeAll(async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address });

      const signature = await testWallet.signMessage(challengeRes.body.message);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeRes.body.message,
        });

      accessToken = loginRes.body.accessToken;
    });

    it('should return user profile with valid token', () => {
      return request(app.getHttpServer())
        .get('/auth/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.address).toBe(testWallet.address.toLowerCase());
        });
    });

    it('should reject without token', () => {
      return request(app.getHttpServer())
        .get('/auth/profile')
        .expect(403);
    });

    it('should reject with invalid token', () => {
      return request(app.getHttpServer())
        .get('/auth/profile')
        .set('Authorization', 'Bearer invalid-token')
        .expect(403);
    });
  });

  // ── GET /auth/health ─────────────────────────────────────────────────────

  describe('GET /auth/health', () => {
    it('should return gateway health status', () => {
      return request(app.getHttpServer())
        .get('/auth/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.service).toBe('Authentication Gateway');
          expect(res.body.features.siwe).toBe(true);
          expect(res.body.features.refreshTokens).toBe(true);
          expect(res.body.features.replayProtection).toBe(true);
          expect(res.body.supportedProviders).toContain('MetaMask');
          expect(res.body.supportedProviders).toContain('WalletConnect');
        });
    });
  });

  // ── Protected Endpoint Access ────────────────────────────────────────────

  describe('Protected endpoints', () => {
    let accessToken: string;

    beforeAll(async () => {
      const challengeRes = await request(app.getHttpServer())
        .post('/auth/challenge')
        .send({ address: testWallet.address });

      const signature = await testWallet.signMessage(challengeRes.body.message);

      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature,
          message: challengeRes.body.message,
        });

      accessToken = loginRes.body.accessToken;
    });

    it('should require auth for POST /claims', () => {
      return request(app.getHttpServer())
        .post('/claims')
        .send({ title: 'Test claim' })
        .expect(403);
    });

    it('should allow GET /claims/latest without auth', () => {
      return request(app.getHttpServer())
        .get('/claims/latest')
        .expect(200);
    });
  });

  // ── Standardized Error Responses ─────────────────────────────────────────

  describe('Standardized error responses', () => {
    it('should return standardized error for invalid login', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature: '0xinvalid',
          message: 'random message',
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.code).toBeDefined();
          expect(res.body.timestamp).toBeDefined();
          expect(res.body.path).toBe('/auth/login');
        });
    });

    it('should return standardized error for missing challenge', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({
          address: testWallet.address,
          signature: '0x' + 'a'.repeat(130),
          message: 'Sign in to TruthBounty: nonexistent',
        })
        .expect(401)
        .expect((res) => {
          expect(res.body.code).toBeDefined();
          expect(res.body.timestamp).toBeDefined();
        });
    });
  });
});
