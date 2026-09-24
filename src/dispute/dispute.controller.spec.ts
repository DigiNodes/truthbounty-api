import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeTrigger } from './entities/dispute.entity';

describe('DisputeController validation', () => {
  let app: INestApplication;

  const disputeService = {
    createDispute: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    startReview: jest.fn(),
    resolveDispute: jest.fn(),
    rejectDispute: jest.fn(),
    getDisputeByClaimId: jest.fn(),
    getExpiredDisputes: jest.fn(),
    findAll: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputeController],
      providers: [
        {
          provide: DisputeService,
          useValue: disputeService,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unknown DTO fields with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/disputes')
      .send({
        claimId: 'claim-1',
        trigger: DisputeTrigger.MANUAL,
        originalConfidence: 0.55,
        unexpected: 'value',
      })
      .expect(400);

    expect(response.body.message).toContain('property unexpected should not exist');
    expect(disputeService.createDispute).not.toHaveBeenCalled();
  });

  it('rejects invalid dispute payloads with clear messages', async () => {
    const response = await request(app.getHttpServer())
      .post('/disputes')
      .send({
        claimId: '',
        trigger: 'INVALID_TRIGGER',
        originalConfidence: 1.5,
      })
      .expect(400);

    expect(response.body.message).toEqual(
      expect.arrayContaining([
        'claimId should not be empty',
        'trigger must be one of the following values: LOW_CONFIDENCE, MINORITY_OPPOSITION, MANUAL',
        'originalConfidence must not be greater than 1',
      ]),
    );
    expect(disputeService.createDispute).not.toHaveBeenCalled();
  });
});