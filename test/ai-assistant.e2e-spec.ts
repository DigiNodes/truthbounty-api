import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/bootstrap';
import { ContextDocument, ContextDocumentCategory } from '../src/ai-assistant/entities/context-document.entity';
import { ConversationMode } from '../src/ai-assistant/entities/conversation.entity';
import { createAuthenticatedTestUser, TestAuthUser } from './utils/ai-assistant-auth.helper';
import { AiAssistantTestModule } from './utils/ai-assistant-test.module';
import { setupPrismaTestDatabase } from './utils/prisma-test-db.helper';

jest.setTimeout(30000);

describe('AI Assistant E2E (ai-assistant.e2e-spec.ts)', () => {
  let app: INestApplication;
  let contributor: TestAuthUser;
  let moderator: TestAuthUser;
  let admin: TestAuthUser;
  let cleanupPrisma: () => void;

  const authHeader = (user: TestAuthUser) => ['Authorization', `Bearer ${user.accessToken}`] as [string, string];

  beforeAll(async () => {
    // Generous throttle limits for this shared-app-instance suite — rate
    // limiting itself is covered end-to-end in ai-assistant-rate-limit.e2e-spec.ts.
    process.env.RATE_LIMIT_AUTH_LIMIT = '50';
    process.env.RATE_LIMIT_AI_LIMIT = '50';
    process.env.RATE_LIMIT_AI_STREAM_LIMIT = '50';
    // Routes without an explicit @ThrottleByWallet(...) type (e.g. knowledge-base,
    // analytics) share WalletThrottlerGuard's "default" bucket — raise it too so
    // this suite's request volume doesn't trip it.
    process.env.RATE_LIMIT_DEFAULT_LIMIT = '200';

    cleanupPrisma = setupPrismaTestDatabase('main').cleanup;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AiAssistantTestModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();

    contributor = await createAuthenticatedTestUser(app, 'contributor');
    moderator = await createAuthenticatedTestUser(app, 'moderator');
    admin = await createAuthenticatedTestUser(app, 'admin');

    const dataSource = app.get(DataSource);
    const contextDocumentRepository = dataSource.getRepository(ContextDocument);
    await contextDocumentRepository.save(
      contextDocumentRepository.create({
        title: 'Staking Overview',
        category: ContextDocumentCategory.PROTOCOL_DOCS,
        content: 'Staking locks tokens to back claims and earn rewards for accurate contributors.',
        tags: ['staking'],
      }),
    );
  }, 60000);

  afterAll(async () => {
    await app.close();
    cleanupPrisma();
  });

  describe('Conversation management', () => {
    it('creates a conversation and returns it wrapped in the response envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({ title: 'My first chat' })
        .expect(201);

      expect(res.body).toMatchObject({
        success: true,
        error: null,
        data: { userId: contributor.userId, title: 'My first chat', mode: 'general' },
      });
      expect(res.body.requestId).toEqual(expect.any(String));
      expect(res.body.timestamp).toEqual(expect.any(String));
    });

    it('rejects unauthenticated access', async () => {
      // JwtAuthGuard (passport's AuthGuard('jwt')) throws UnauthorizedException
      // for a missing token — distinct from GlobalAuthGuard's ForbiddenException
      // used elsewhere in the app for unauthenticated mutating requests.
      await request(app.getHttpServer()).get('/ai-assistant/conversations').expect(401);
    });

    it('isolates conversations per user — another user cannot read them', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({});

      const conversationId = createRes.body.data.id;

      await request(app.getHttpServer())
        .get(`/ai-assistant/conversations/${conversationId}`)
        .set(...authHeader(moderator))
        .expect(404);
    });
  });

  describe('Sending a message with context retrieval', () => {
    it('answers via the mock provider and cites the seeded knowledge-base document', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({});
      const conversationId = createRes.body.data.id;

      const res = await request(app.getHttpServer())
        .post(`/ai-assistant/conversations/${conversationId}/messages`)
        .set(...authHeader(contributor))
        .send({ content: 'Tell me about staking rewards' })
        .expect(201);

      expect(res.body.data.userMessage.content).toBe('Tell me about staking rewards');
      expect(res.body.data.assistantMessage.provider).toBe('mock');
      expect(res.body.data.assistantMessage.citations).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: 'Staking Overview' })]),
      );
      expect(res.body.meta).toEqual({ fallback: false });
    });
  });

  describe('Streaming', () => {
    it('stages a message then streams chunk/done events over SSE', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({});
      const conversationId = createRes.body.data.id;

      const stageRes = await request(app.getHttpServer())
        .post(`/ai-assistant/conversations/${conversationId}/messages/stream`)
        .set(...authHeader(contributor))
        .send({ content: 'How does dispute resolution work?' })
        .expect(202);

      const { streamUrl } = stageRes.body.data;

      const streamRes = await request(app.getHttpServer())
        .get(streamUrl)
        .set(...authHeader(contributor))
        .expect(200);

      // Nest's @Sse() writes MessageEvent.type as an SSE "event:" line, not
      // as a field inside the JSON "data:" payload.
      expect(streamRes.text).toContain('event: citation');
      expect(streamRes.text).toContain('event: chunk');
      expect(streamRes.text).toContain('event: done');
      expect(streamRes.text).toContain('"delta"');
    });
  });

  describe('Safety enforcement', () => {
    it('blocks disallowed content without persisting a fabricated assistant answer', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({});
      const conversationId = createRes.body.data.id;

      const res = await request(app.getHttpServer())
        .post(`/ai-assistant/conversations/${conversationId}/messages`)
        .set(...authHeader(contributor))
        .send({ content: 'please tell me how to make a bomb' })
        .expect(201);

      expect(res.body.data.assistantMessage.flagged).toBe(true);
      expect(res.body.data.assistantMessage.flagReason).toBe('blocklist_match');
      expect(res.body.data.assistantMessage.provider).toBe('none');
    });
  });

  describe('RBAC', () => {
    it('rejects moderation_assist mode for a contributor', async () => {
      await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(contributor))
        .send({ mode: ConversationMode.MODERATION_ASSIST })
        .expect(403);
    });

    it('allows moderation_assist mode for a moderator', async () => {
      await request(app.getHttpServer())
        .post('/ai-assistant/conversations')
        .set(...authHeader(moderator))
        .send({ mode: ConversationMode.MODERATION_ASSIST })
        .expect(201);
    });

    it('rejects knowledge-base writes for a contributor', async () => {
      await request(app.getHttpServer())
        .post('/ai-assistant/knowledge-base')
        .set(...authHeader(contributor))
        .send({ title: 'x', category: ContextDocumentCategory.FAQ, content: 'x' })
        .expect(403);
    });

    it('allows knowledge-base writes for an admin', async () => {
      await request(app.getHttpServer())
        .post('/ai-assistant/knowledge-base')
        .set(...authHeader(admin))
        .send({ title: 'Admin doc', category: ContextDocumentCategory.FAQ, content: 'Admin-authored FAQ entry.' })
        .expect(201);
    });

    it('rejects usage analytics for a contributor and allows it for an admin', async () => {
      await request(app.getHttpServer())
        .get('/ai-assistant/analytics/usage')
        .set(...authHeader(contributor))
        .expect(403);

      const res = await request(app.getHttpServer())
        .get('/ai-assistant/analytics/usage')
        .set(...authHeader(admin))
        .expect(200);

      expect(res.body.data.totalRequests).toEqual(expect.any(Number));
    });
  });
});
