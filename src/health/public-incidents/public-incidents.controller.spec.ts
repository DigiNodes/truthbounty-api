import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PublicIncidentController } from './public-incidents.controller';
import { PublicIncidentService } from './public-incidents.service';
import { PublicIncidentRateLimitGuard } from './public-incidents-rate-limit.guard';
import {
  PUBLIC_INCIDENT_OPTIONS,
  PublicIncidentOptions,
} from './public-incidents.options';
import {
  RAW_MONITORING_INCIDENT,
  RAW_RESOLVED_INCIDENT,
  SCENARIO_NOW,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-incidents.scenarios';
import {
  projectPublicIncidentDetail,
  projectPublicIncidentList,
} from './public-incidents.projector';
import { NotFoundException } from '@nestjs/common';

const testOptions: PublicIncidentOptions = {
  cacheTtlSeconds: 15,
  staleAfterSeconds: 120,
  rateLimit: 3,
  rateLimitWindowSeconds: 60,
};

describe('PublicIncidentController (UX-BE-002)', () => {
  let app: INestApplication;
  const mockService = {
    findAll: jest.fn(),
    findById: jest.fn(),
    getOptions: () => testOptions,
  };

  beforeEach(async () => {
    mockService.findAll.mockReset();
    mockService.findById.mockReset();

    const listBody = projectPublicIncidentList(
      [RAW_MONITORING_INCIDENT, RAW_RESOLVED_INCIDENT],
      2,
      1,
      10,
      SCENARIO_NOW,
      SCENARIO_POLICY,
    );
    mockService.findAll.mockResolvedValue({
      body: listBody,
      maxAgeSeconds: 15,
    });

    const detailBody = projectPublicIncidentDetail(RAW_RESOLVED_INCIDENT);
    mockService.findById.mockImplementation((id: string) => {
      if (id === RAW_RESOLVED_INCIDENT.id) {
        return Promise.resolve({
          body: detailBody,
          maxAgeSeconds: 15,
        });
      }
      return Promise.reject(
        new NotFoundException(`Incident with ID ${id} not found`),
      );
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [PublicIncidentController],
      providers: [
        { provide: PublicIncidentService, useValue: mockService },
        { provide: PUBLIC_INCIDENT_OPTIONS, useValue: testOptions },
        PublicIncidentRateLimitGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it('GET /status/incidents returns 200 with schema and cache headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/status/incidents')
      .expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=15');
    expect(res.headers['x-public-incidents-schema']).toBe('public-incidents.v1');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
  });

  it('GET /status/incidents/:id returns 200 with sanitized detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/status/incidents/${RAW_RESOLVED_INCIDENT.id}`)
      .expect(200);

    expect(res.body.id).toBe(RAW_RESOLVED_INCIDENT.id);
    expect(res.body.status).toBe('resolved');
    expect(res.body.postIncidentLinks).toHaveLength(1);
    expect(res.body.publicationHistory).toHaveLength(3);
  });

  it('GET /status/incidents/:id returns 404 for unknown ID', async () => {
    await request(app.getHttpServer())
      .get('/status/incidents/inc-unknown')
      .expect(404);
  });

  it('rate limits per client with 429 when threshold exceeded', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).get('/status/incidents').expect(200);
    }
    const res = await request(server).get('/status/incidents').expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });
});
