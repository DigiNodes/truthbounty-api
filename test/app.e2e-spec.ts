import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});

describe('Throttler storage integration', () => {
  let app: INestApplication<App>;
  let originalDefaultLimit: string | undefined;
  let originalDefaultTtl: string | undefined;

  beforeAll(() => {
    originalDefaultLimit = process.env.RATE_LIMIT_DEFAULT_LIMIT;
    originalDefaultTtl = process.env.RATE_LIMIT_DEFAULT_TTL;
    process.env.RATE_LIMIT_DEFAULT_LIMIT = '3';
    process.env.RATE_LIMIT_DEFAULT_TTL = '1';
  });

  afterAll(() => {
    if (originalDefaultLimit !== undefined) {
      process.env.RATE_LIMIT_DEFAULT_LIMIT = originalDefaultLimit;
    } else {
      delete process.env.RATE_LIMIT_DEFAULT_LIMIT;
    }

    if (originalDefaultTtl !== undefined) {
      process.env.RATE_LIMIT_DEFAULT_TTL = originalDefaultTtl;
    } else {
      delete process.env.RATE_LIMIT_DEFAULT_TTL;
    }
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('blocks after the configured limit and then unblocks after the window expires', async () => {
    const server = app.getHttpServer();
    const walletHeader = { 'x-wallet-address': '0xTEST' };

    for (let i = 0; i < 3; i++) {
      await request(server).get('/').set(walletHeader).expect(200);
    }

    await request(server).get('/').set(walletHeader).expect(429);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    await request(server).get('/').set(walletHeader).expect(200);
  });
});
