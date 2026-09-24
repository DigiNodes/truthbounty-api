import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Identity Security (e2e)', () => {
  let app: INestApplication;

  let userToken: string;
  let attackerToken: string;
  let userId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // ⚠️ Mock tokens (replace with real auth flow if needed)
    userId = 'user-1';

    userToken = 'valid-token-user-1';
    attackerToken = 'valid-token-user-2';
  });

  afterAll(async () => {
    await app.close();
  });

  it('❌ should return 401 when no token provided', async () => {
    await request(app.getHttpServer())
      .post(`/identity/users/${userId}/verify-worldcoin`)
      .expect(401);
  });

  it('❌ should return 403 when another user tries to verify', async () => {
    await request(app.getHttpServer())
      .post(`/identity/users/${userId}/verify-worldcoin`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .expect(403);
  });

  it('✅ should allow owner to verify', async () => {
    await request(app.getHttpServer())
      .post(`/identity/users/${userId}/verify-worldcoin`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(201 || 200);
  });
});