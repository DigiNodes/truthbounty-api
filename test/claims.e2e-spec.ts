import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('Claims (e2e)', () => {
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

  it('GET /claims/:id returns 410 instead of serving legacy rows', async () => {
    const unknownId = 'non-existent-id';

    await request(app.getHttpServer())
      .get(`/claims/${unknownId}`)
      .expect(410)
      .expect((res) => {
        expect(res.body.code).toBe('CANONICAL_CHAIN_STATE_REQUIRED');
        expect(res.body.canonicalPath).toBe('/api/v2/claim-read-models');
      });
  });

  it('POST /claims remains authenticated before reaching the deprecated handler', async () => {
    await request(app.getHttpServer())
      .post('/claims')
      .send({ title: 'Test claim', content: 'Not persisted' })
      .expect(403);
  });
});
