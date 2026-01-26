import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../app.module';

describe('EventIndexer E2E', () => {
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

  describe('GET /indexer/status', () => {
    it('should return indexer status', () => {
      return request(app.getHttpServer())
        .get('/indexer/status')
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.data).toBeDefined();
        });
    });
  });

  describe('POST /indexer/restart', () => {
    it('should restart the indexer', () => {
      return request(app.getHttpServer())
        .post('/indexer/restart')
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
        });
    });
  });

  describe('POST /indexer/backfill', () => {
    it('should accept backfill request', () => {
      return request(app.getHttpServer())
        .post('/indexer/backfill')
        .send({
          contractAddress: '0x0000000000000000000000000000000000000000',
          blockNumber: 1000,
        })
        .expect(200);
    });

    it('should reject invalid backfill request', () => {
      return request(app.getHttpServer())
        .post('/indexer/backfill')
        .send({})
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(false);
        });
    });
  });
});
