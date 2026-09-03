/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('HealthController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health/live (GET) returns alive', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('alive');
        expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      });
  });

  it('/health/ready (GET) returns readiness status', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.ready).toBe('boolean');
        expect(res.body.dependencies).toBeInstanceOf(Array);
      });
  });

  it('/health (GET) returns aggregated report', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(['healthy', 'degraded', 'unhealthy']).toContain(res.body.status);
        expect(res.body.services).toBeDefined();
        expect(res.body.dependencies).toBeInstanceOf(Array);
      });
  });
});
