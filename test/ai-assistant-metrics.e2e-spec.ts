import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/bootstrap';
import { ContextDocument, ContextDocumentCategory } from '../src/ai-assistant/entities/context-document.entity';
import { createAuthenticatedTestUser, TestAuthUser } from './utils/ai-assistant-auth.helper';
import { AiAssistantTestModule } from './utils/ai-assistant-test.module';
import { setupPrismaTestDatabase } from './utils/prisma-test-db.helper';

jest.setTimeout(30000);

describe('AI Assistant monitoring & caching E2E (ai-assistant-metrics.e2e-spec.ts)', () => {
  let app: INestApplication;
  let contributor: TestAuthUser;
  let cleanupPrisma: () => void;
  let conversationId: string;

  const authHeader = (user: TestAuthUser) => ['Authorization', `Bearer ${user.accessToken}`] as [string, string];

  const getMetricValue = (metricsText: string, name: string): number => {
    // Sum all label-combinations for a counter/histogram-count line, e.g.
    // `ai_cache_hits_total{cacheType="context"} 3`
    const lines = metricsText.split('\n').filter((l) => l.startsWith(name + '{') || l.startsWith(name + ' '));
    return lines.reduce((sum, line) => {
      const value = Number(line.trim().split(/\s+/).pop());
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_LIMIT = '50';
    process.env.RATE_LIMIT_AI_LIMIT = '50';
    process.env.RATE_LIMIT_DEFAULT_LIMIT = '50';

    cleanupPrisma = setupPrismaTestDatabase('metrics').cleanup;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AiAssistantTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    contributor = await createAuthenticatedTestUser(app, 'contributor');

    const dataSource = app.get(DataSource);
    const contextDocumentRepository = dataSource.getRepository(ContextDocument);
    await contextDocumentRepository.save(
      contextDocumentRepository.create({
        title: 'Governance Overview',
        category: ContextDocumentCategory.GOVERNANCE,
        content: 'Governance proposals let contributors vote on protocol parameter changes.',
        tags: ['governance'],
      }),
    );

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

  it('exposes ai_* series on GET /metrics after a chat request', async () => {
    await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'How does governance voting work?' })
      .expect(201);

    const metricsRes = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(metricsRes.text).toContain('ai_requests_total');
    expect(metricsRes.text).toContain('ai_request_duration_seconds');
    expect(metricsRes.text).toContain('ai_tokens_total');
    expect(metricsRes.text).toContain('provider="mock"');
  });

  it('records a cache miss then a cache hit for a repeated context-retrieval query', async () => {
    const before = (await request(app.getHttpServer()).get('/metrics').expect(200)).text;
    const missesBefore = getMetricValue(before, 'ai_cache_misses_total');
    const hitsBefore = getMetricValue(before, 'ai_cache_hits_total');

    // First call: cache miss, populates the context-retrieval cache.
    await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'Tell me about governance proposals' })
      .expect(201);

    // Second call with the same content: should hit the cache this time.
    await request(app.getHttpServer())
      .post(`/ai-assistant/conversations/${conversationId}/messages`)
      .set(...authHeader(contributor))
      .send({ content: 'Tell me about governance proposals' })
      .expect(201);

    const after = (await request(app.getHttpServer()).get('/metrics').expect(200)).text;
    const missesAfter = getMetricValue(after, 'ai_cache_misses_total');
    const hitsAfter = getMetricValue(after, 'ai_cache_hits_total');

    expect(missesAfter).toBeGreaterThan(missesBefore);
    expect(hitsAfter).toBeGreaterThan(hitsBefore);
  });
});
