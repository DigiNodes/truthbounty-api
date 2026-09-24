/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('FeatureFlagsController (e2e)', () => {
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

  it('/feature-flags (GET) returns list', () => {
    return request(app.getHttpServer())
      .get('/feature-flags')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });

  it('/feature-flags/evaluate/:key (GET) returns evaluation', () => {
    return request(app.getHttpServer())
      .get('/feature-flags/evaluate/unknown-flag')
      .expect(200)
      .expect((res) => {
        expect(res.body.key).toBe('unknown-flag');
        expect(res.body.enabled).toBe(false);
      });
  });
});
