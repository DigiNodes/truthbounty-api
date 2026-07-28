import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('SearchController (e2e)', () => {
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

  it('/search (GET) returns global search results', () => {
    return request(app.getHttpServer())
      .get('/search?q=test')
      .expect(200)
      .expect((res) => {
        expect(res.body.query).toBe('test');
        expect(res.body.claims).toBeDefined();
        expect(res.body.disputes).toBeDefined();
        expect(res.body.users).toBeDefined();
      });
  });

  it('/search/:entity (GET) returns entity-specific results', () => {
    return request(app.getHttpServer())
      .get('/search/claims?q=test')
      .expect(200)
      .expect((res) => {
        expect(res.body.data).toBeInstanceOf(Array);
        expect(res.body.total).toBeGreaterThanOrEqual(0);
      });
  });
});
