import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/bootstrap';
import { createAuthenticatedTestUser, TestAuthUser } from './utils/ai-assistant-auth.helper';
import { AiAssistantTestModule } from './utils/ai-assistant-test.module';
import { setupPrismaTestDatabase } from './utils/prisma-test-db.helper';

jest.setTimeout(30000);

describe('AI Assistant rate limiting E2E (ai-assistant-rate-limit.e2e-spec.ts)', () => {
  let app: INestApplication;
  let contributor: TestAuthUser;
  let cleanupPrisma: () => void;
  let conversationId: string;

  const authHeader = (user: TestAuthUser) => ['Authorization', `Bearer ${user.accessToken}`] as [string, string];

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_LIMIT = '50';
    // Deliberately low so a handful of requests reliably trips the limit.
    process.env.RATE_LIMIT_AI_LIMIT = '2';
    process.env.RATE_LIMIT_AI_TTL = '60';

    cleanupPrisma = setupPrismaTestDatabase('rate-limit').cleanup;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AiAssistantTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    contributor = await createAuthenticatedTestUser(app, 'contributor');

    const createRes = await request(app.getHttpServer())
      .post('/ai-assistant/conversations')
      .set(...authHeader(contributor))
      .send({});
    conversationId = createRes.body.data.id;
  }, 60000);

  afterAll(async () => {
    await app.close();
    cleanupPrisma();
  });

  it('allows requests within the configured limit and rejects once exceeded', async () => {
    // RATE_LIMIT_AI_LIMIT=2: first two POSTs to .../messages succeed.
    await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'first message' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'second message' })
      .expect(201);

    // Third exceeds the limit within the same window.
    const res = await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'third message' })
      .expect(429);

    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
    });
  });
});
