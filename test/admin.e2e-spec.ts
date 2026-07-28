import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { AdminRole } from '../src/admin/entities/admin.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Admin } from '../src/admin/entities/admin.entity';
import { Repository } from 'typeorm';

describe('Admin & Moderation API (e2e)', () => {
  let app: INestApplication;
  let adminRepo: Repository<Admin>;
  let jwtToken: string;
  let adminId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    adminRepo = app.get(getRepositoryToken(Admin));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Admin Authentication', () => {
    it('POST /admin/auth/login should reject non-admin wallets', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ address: '0xnonexistent' })
        .expect(201);

      expect(res.body.authenticated).toBe(false);
    });

    it('POST /admin/auth/login should authenticate admin wallets', async () => {
      const admin = await adminRepo.save({
        walletAddress: '0xadmin-test-wallet',
        role: AdminRole.ADMINISTRATOR,
        isActive: true,
      });
      adminId = admin.id;

      const res = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ address: '0xadmin-test-wallet' })
        .expect(201);

      expect(res.body.authenticated).toBe(true);
      expect(res.body.admin.role).toBe(AdminRole.ADMINISTRATOR);
    });
  });

  describe('Admin Profile', () => {
    it('GET /admin/auth/profile should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/auth/profile')
        .expect(401);
    });
  });

  describe('RBAC Enforcement', () => {
    it('should enforce role-based access on admin creation', async () => {
      const auditor = await adminRepo.save({
        walletAddress: '0xauditor-wallet',
        role: AdminRole.AUDITOR,
        isActive: true,
      });

      await request(app.getHttpServer())
        .post('/admin/admins')
        .set('Authorization', 'Bearer invalid-token')
        .send({ walletAddress: '0xnew-admin', role: AdminRole.MODERATOR })
        .expect(401);
    });
  });

  describe('Dashboard Endpoints', () => {
    it('GET /admin/dashboard/overview should return dashboard data', async () => {
      await request(app.getHttpServer())
        .get('/admin/dashboard/overview')
        .expect(401);
    });

    it('GET /admin/dashboard/health should return health status', async () => {
      await request(app.getHttpServer())
        .get('/admin/dashboard/health')
        .expect(401);
    });
  });

  describe('Moderation Endpoints', () => {
    it('GET /admin/moderation/queue should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/moderation/queue')
        .expect(401);
    });

    it('POST /admin/moderation/reports should require auth', async () => {
      await request(app.getHttpServer())
        .post('/admin/moderation/reports')
        .send({
          type: 'flagged_claim',
          title: 'Test report',
          description: 'Test description',
        })
        .expect(401);
    });
  });

  describe('Incident Endpoints', () => {
    it('POST /admin/incidents should require auth', async () => {
      await request(app.getHttpServer())
        .post('/admin/incidents')
        .send({
          title: 'Test incident',
          description: 'Test description',
          classification: 'security_breach',
          severity: 'high',
        })
        .expect(401);
    });

    it('GET /admin/incidents should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/incidents')
        .expect(401);
    });

    it('GET /admin/incidents/stats/summary should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/incidents/stats/summary')
        .expect(401);
    });
  });

  describe('Monitoring Endpoints', () => {
    it('GET /admin/dashboard/monitoring should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/dashboard/monitoring')
        .expect(401);
    });

    it('GET /admin/dashboard/audit should require auth', async () => {
      await request(app.getHttpServer())
        .get('/admin/dashboard/audit')
        .expect(401);
    });
  });
});
