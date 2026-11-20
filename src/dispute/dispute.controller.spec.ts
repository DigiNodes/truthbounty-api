jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeJournalStore } from './dispute-journal.store';
import { DisputeProjectionService } from './dispute-projection.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

describe('dispute HTTP authority boundary', () => {
  let app: INestApplication;
  const address = '0x' + 'a'.repeat(40);
  const store = {
    create: jest.fn(),
    review: jest.fn(),
    workflows: jest.fn().mockResolvedValue([]),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DisputeController],
      providers: [
        DisputeService,
        { provide: DisputeJournalStore, useValue: store },
        {
          provide: DisputeProjectionService,
          useValue: {
            release: () => ({}),
            snapshot: async () => ({ items: [] }),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: any) {
          const req = context.switchToHttp().getRequest();
          if (!req.headers['x-test-role']) throw new UnauthorizedException();
          req.user = { address, user: { role: req.headers['x-test-role'] } };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    store.create.mockImplementation(
      async (_scope, claimId, actor, metadata) => ({
        id: 'w',
        claimId,
        initiatorAddress: actor,
        metadata,
        reviewStatus: 'REQUESTED',
      }),
    );
    store.review.mockImplementation(async (_scope, id, actor, status) => ({
      id,
      reviewedBy: actor,
      reviewStatus: status,
    }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('leaves public projections readable but requires verified identity for requests', async () => {
    await request(app.getHttpServer()).get('/disputes').expect(200);
    await request(app.getHttpServer())
      .post('/disputes')
      .send({ claimId: 'c' })
      .expect(401);
    const result = await request(app.getHttpServer())
      .post('/disputes')
      .set('x-test-role', 'contributor')
      .send({ claimId: 'c' })
      .expect(201);
    expect(result.body.workflow.initiatorAddress).toBe(address);
    expect(result.body.workflow.authority).toBe('non_authoritative_workflow');
  });

  it.each([
    'initiatorId',
    'trigger',
    'originalConfidence',
    'outcome',
    'finalConfidence',
  ])('rejects HTTP authority injection: %s', async (field) => {
    await request(app.getHttpServer())
      .post('/disputes')
      .set('x-test-role', 'contributor')
      .send({ claimId: 'c', [field]: 'injected' })
      .expect(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('enforces moderator access and keeps dismissal non-authoritative', async () => {
    await request(app.getHttpServer())
      .patch('/disputes/w/review')
      .set('x-test-role', 'contributor')
      .send({ status: 'DISMISSED' })
      .expect(403);
    const result = await request(app.getHttpServer())
      .patch('/disputes/w/review')
      .set('x-test-role', 'moderator')
      .send({ status: 'DISMISSED' })
      .expect(200);
    expect(result.body.workflow.reviewStatus).toBe('DISMISSED');
    expect(result.body).not.toHaveProperty('outcome');
    await request(app.getHttpServer())
      .patch('/disputes/w/review')
      .set('x-test-role', 'admin')
      .send({ status: 'RESOLVED' })
      .expect(400);
  });

  it.each(['resolve', 'reject'])(
    'returns 410 for retired %s even to administrators',
    async (route) => {
      await request(app.getHttpServer())
        .patch('/disputes/w/' + route)
        .set('x-test-role', 'admin')
        .send({ outcome: 'CONFIRMED', finalConfidence: 1 })
        .expect(410);
      expect(store.review).not.toHaveBeenCalled();
    },
  );
});
