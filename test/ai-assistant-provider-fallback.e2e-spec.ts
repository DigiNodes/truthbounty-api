import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/bootstrap';
import { createAuthenticatedTestUser, TestAuthUser } from './utils/ai-assistant-auth.helper';
import { AiAssistantTestModule } from './utils/ai-assistant-test.module';
import { setupPrismaTestDatabase } from './utils/prisma-test-db.helper';

jest.setTimeout(30000);

describe('AI Assistant provider fallback E2E (ai-assistant-provider-fallback.e2e-spec.ts)', () => {
  let app: INestApplication;
  let contributor: TestAuthUser;
  let cleanupPrisma: () => void;

  const authHeader = (user: TestAuthUser) => ['Authorization', `Bearer ${user.accessToken}`] as [string, string];

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_LIMIT = '50';
    process.env.RATE_LIMIT_AI_LIMIT = '50';
    process.env.RATE_LIMIT_DEFAULT_LIMIT = '50';

    // Configure openai as the primary provider, pointed at a port nothing
    // listens on — the connection is refused immediately (no real network
    // access needed, no slow DNS/timeout), so OpenAiProvider.isAvailable()
    // deterministically returns false and AiProviderRouterService falls
    // back to the mock provider, which serves the request successfully.
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1';

    cleanupPrisma = setupPrismaTestDatabase('fallback').cleanup;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AiAssistantTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    contributor = await createAuthenticatedTestUser(app, 'contributor');
  }, 60000);

  afterAll(async () => {
    await app.close();
    cleanupPrisma();
    delete process.env.AI_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  it('falls back to the mock provider when the configured primary is unreachable', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/ai-assistant/conversations')
      .set(...authHeader(contributor))
      .send({});
    const conversationId = createRes.body.data.id;

    const res = await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'Is anyone there?' })
      .expect(201);

    expect(res.body.data.assistantMessage.provider).toBe('mock');
    expect(res.body.meta).toEqual({ fallback: true });
  });
});
