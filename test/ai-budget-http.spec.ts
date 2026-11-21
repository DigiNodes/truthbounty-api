import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AiAssistantController } from '../src/ai-assistant/ai-assistant.controller';
import { AiAssistantService } from '../src/ai-assistant/services/ai-assistant.service';
import { LlmProviderService } from '../src/ai-assistant/services/llm-provider.service';
import { RagService } from '../src/ai-assistant/services/rag.service';
import { SafetyGuardrailService } from '../src/ai-assistant/services/safety-guardrail.service';
import { AiBudgetService } from '../src/ai-assistant/budgets/ai-budget.service';
import { AiBudgetError } from '../src/ai-assistant/budgets/ai-budget.errors';
import { AiBudgetExceptionFilter } from '../src/ai-assistant/budgets/ai-budget-exception.filter';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { createGlobalValidationPipe } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

const mockChat = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChat } },
    embeddings: { create: jest.fn() },
  })),
}));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(),
}));
// The HTTP harness supplies the existing conversation store and verified identity.
// Real PostgreSQL admission is exercised separately; it never starts LibSQL here.
jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const THREAD = '00000000-0000-4000-8000-000000000003';
const RESERVATION = '00000000-0000-4000-8000-000000000004';
const PRICE = '00000000-0000-4000-8000-000000000005';

describe('active AI conversation budget HTTP contract', () => {
  let app: INestApplication;
  let prisma: any;
  let budget: any;
  let safety: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue({ id: THREAD, userId: USER }),
        update: jest.fn().mockResolvedValue({ id: THREAD }),
      },
      message: {
        create: jest.fn(async ({ data }) => ({ id: RESERVATION, ...data })),
        findMany: jest.fn().mockResolvedValue([{ role: 'user', content: 'protocol question' }]),
      },
      aiUsageMetric: { create: jest.fn() },
    };
    budget = {
      reserve: jest.fn().mockRejectedValue(new AiBudgetError(
        'AI_BUDGET_EXHAUSTED',
        new Date('2026-12-01T00:00:00Z'),
        new Date('2026-11-30T23:59:00Z'),
      )),
      reconcile: jest.fn(),
    };
    safety = { checkContent: jest.fn().mockReturnValue({ flagged: false }) };
    const values: Record<string, string> = {
      NODE_ENV: 'test', OPENAI_API_KEY: 'provider-test-fixture',
      DEFAULT_LLM_PROVIDER: 'openai',
    };
    const module = await Test.createTestingModule({
      controllers: [AiAssistantController],
      providers: [
        AiAssistantService, LlmProviderService, AiBudgetExceptionFilter,
        { provide: ConfigService, useValue: { get: (key: string) => values[key] } },
        { provide: PrismaService, useValue: prisma },
        { provide: AiBudgetService, useValue: budget },
        { provide: RagService, useValue: { retrieveContext: jest.fn().mockResolvedValue({ context: '', citations: [] }) } },
        { provide: SafetyGuardrailService, useValue: safety },
      ],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().user = {
          id: USER, userId: USER, sub: USER, address: '0x' + 'ab'.repeat(20),
          user: { id: USER, role: 'contributor' },
        };
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterEach(async () => { await app?.close(); });

  it('returns a distinct exhausted code and safe reset/header without dispatch', async () => {
    const response = await request(app.getHttpServer())
      .post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'protocol question' }).expect(429);

    expect(response.body).toMatchObject({
      errorCode: 'AI_BUDGET_EXHAUSTED', state: 'exhausted',
      resetAt: '2026-12-01T00:00:00.000Z', retryAfterSeconds: 60,
    });
    expect(response.headers['retry-after']).toBe('60');
    expect(mockChat).not.toHaveBeenCalled();
    expect(budget.reconcile).not.toHaveBeenCalled();
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
    expect(prisma.message.create.mock.calls.some(([call]) => call.data.role === 'assistant')).toBe(false);
    expect(response.body).not.toHaveProperty('remainingTokens');
    expect(response.body).not.toHaveProperty('userId');
  });

  it('reports missing store separately and does not call a paid provider', async () => {
    budget.reserve.mockRejectedValue(new AiBudgetError('AI_BUDGET_UNAVAILABLE'));
    const response = await request(app.getHttpServer())
      .post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'protocol question' }).expect(503);
    expect(response.body).toMatchObject({
      errorCode: 'AI_BUDGET_UNAVAILABLE', state: 'unavailable', resetAt: null,
    });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('denies another conversation owner before reserving or dispatching', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: THREAD, userId: OTHER });
    await request(app.getHttpServer()).post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'protocol question' }).expect(403);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('keeps safety refusal local without a paid reservation', async () => {
    safety.checkContent.mockReturnValue({ flagged: true, reason: 'unsafe' });
    const response = await request(app.getHttpServer())
      .post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'blocked fixture' }).expect(201);
    expect(response.body.metadata.flagged).toBe(true);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied cost/provider/token fields before admission', async () => {
    await request(app.getHttpServer()).post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'protocol question', provider: 'anthropic', inputTokens: 0, costUsdNanos: '0' })
      .expect(400);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns truthful unknown accounting after an incomplete paid response', async () => {
    budget.reserve.mockResolvedValue({
      id: RESERVATION, provider: 'openai', model: 'gpt-4o-mini',
      priceVersion: PRICE, maxInputTokens: 128000, maxOutputTokens: 16384,
    });
    mockChat.mockResolvedValue({ choices: [{ message: { content: 'partial fixture' } }] });
    budget.reconcile.mockResolvedValue({
      state: 'held', actualTokens: null, chargedTokens: '144384',
      chargedSpendUsdNanos: '1000000', priceVersion: PRICE,
    });
    const response = await request(app.getHttpServer())
      .post('/ai/conversations/' + THREAD + '/messages')
      .send({ content: 'protocol question' }).expect(201);
    expect(response.body.metadata).toMatchObject({
      tokens: null, usageState: 'held', chargedTokens: '144384',
      chargedSpendUsdNanos: '1000000', priceVersion: PRICE,
    });
    expect(budget.reconcile).toHaveBeenCalledWith(RESERVATION, 'usage_missing', null, expect.any(Number));
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(prisma.aiUsageMetric.create).not.toHaveBeenCalled();
  });
});
