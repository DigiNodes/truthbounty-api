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

  it('/search (GET) handles empty query gracefully', () => {
    return request(app.getHttpServer())
      .get('/search')
      .expect(200)
      .expect((res) => {
        expect(res.body.query).toBe('');
        expect(res.body.claims).toBeDefined();
      });
  });

  it('/search (GET) rejects huge query exceeding 256 chars with 400', () => {
    const hugeQuery = 'a'.repeat(300);
    return request(app.getHttpServer())
      .get(`/search?q=${hugeQuery}`)
      .expect(400);
  });

  it('/search (GET) rejects wildcard abuse with 400', () => {
    return request(app.getHttpServer())
      .get('/search?q=%25%25')
      .expect(400);
  });

  it('/search (GET) rejects unapproved private fields in query parameters with 400', () => {
    return request(app.getHttpServer())
      .get('/search?role=ADMIN&q=test')
      .expect(400);
  });

  it('/search (GET) rejects deep-paging result window exceeding 1000 items with 400', () => {
    return request(app.getHttpServer())
      .get('/search?page=60&limit=20')
      .expect(400);
  });
});
