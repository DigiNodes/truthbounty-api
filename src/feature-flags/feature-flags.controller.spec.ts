import {
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConfigurationService } from './configuration.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';

describe('FeatureFlagsController configuration access', () => {
  let app: INestApplication;
  const secretCanary = 'CONFIG_SECRET_CANARY';
  const configurationService = {
    findAll: jest.fn().mockResolvedValue([
      {
        id: 'secret-id',
        key: 'webhookSecret',
        value: secretCanary,
        environment: 'test',
        version: 1,
        createdBy: null,
        changeReason: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'public-id',
        key: 'public.runtime',
        value: { enabled: true, apiToken: 'NESTED_SECRET_CANARY' },
        environment: 'test',
        version: 1,
        createdBy: null,
        changeReason: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
    get: jest.fn().mockImplementation((key: string) =>
      key === 'webhookSecret' ? secretCanary : { enabled: true },
    ),
    getHistory: jest.fn().mockResolvedValue([
      {
        id: 'history-id',
        key: 'webhookSecret',
        value: secretCanary,
        version: 1,
        createdBy: null,
        changeReason: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
  };
  const flagsService = {
    evaluate: jest.fn().mockResolvedValue({
      key: 'public-flag',
      enabled: true,
      reason: 'boolean',
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FeatureFlagsController],
      providers: [
        AdminGuard,
        { provide: FeatureFlagsService, useValue: flagsService },
        { provide: ConfigurationService, useValue: configurationService },
        { provide: AuditTrailService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const authorization = req.headers.authorization;
          if (!authorization) {
            throw new UnauthorizedException('Authentication required');
          }

          req.user =
            authorization === 'Bearer admin'
              ? { address: '0xadmin', user: { role: 'admin' } }
              : { address: '0xuser', user: { role: 'contributor' } };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('denies anonymous and ordinary authenticated configuration reads', async () => {
    const paths = [
      ['/configuration', 'get'],
      ['/configuration/webhookSecret', 'get'],
      ['/configuration/webhookSecret/history', 'get'],
      ['/configuration/secret-id/rollback', 'post'],
    ] as const;

    for (const [path, method] of paths) {
      const anonymous = request(app.getHttpServer())[method](path);
      const anonymousResponse = await anonymous;
      expect([401, 403]).toContain(anonymousResponse.status);
      expect(JSON.stringify(anonymousResponse.body)).not.toContain(
        secretCanary,
      );

      const ordinaryResponse = await request(app.getHttpServer())
        [method](path)
        .set('Authorization', 'Bearer ordinary');
      expect(ordinaryResponse.status).toBe(403);
      expect(JSON.stringify(ordinaryResponse.body)).not.toContain(
        secretCanary,
      );
    }

    expect(configurationService.findAll).not.toHaveBeenCalled();
    expect(configurationService.get).not.toHaveBeenCalled();
    expect(configurationService.getHistory).not.toHaveBeenCalled();
  });

  it('allows administrators while redacting sensitive current and historical values', async () => {
    const listResponse = await request(app.getHttpServer())
      .get('/configuration')
      .set('Authorization', 'Bearer admin')
      .expect(200);
    expect(listResponse.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'webhookSecret', value: '[REDACTED]' }),
        expect.objectContaining({
          key: 'public.runtime',
          value: { enabled: true, apiToken: '[REDACTED]' },
        }),
      ]),
    );

    const valueResponse = await request(app.getHttpServer())
      .get('/configuration/webhookSecret')
      .set('Authorization', 'Bearer admin')
      .expect(200);
    expect(valueResponse.body.value).toBe('[REDACTED]');

    const historyResponse = await request(app.getHttpServer())
      .get('/configuration/webhookSecret/history')
      .set('Authorization', 'Bearer admin')
      .expect(200);
    expect(historyResponse.body[0].value).toBe('[REDACTED]');

    const responseText = JSON.stringify([
      listResponse.body,
      valueResponse.body,
      historyResponse.body,
    ]);
    expect(responseText).not.toContain(secretCanary);
    expect(responseText).not.toContain('NESTED_SECRET_CANARY');
  });

  it('keeps public feature-flag evaluation available and documents redaction', async () => {
    await request(app.getHttpServer())
      .get('/feature-flags/evaluate/public-flag')
      .expect(200)
      .expect({ key: 'public-flag', enabled: true, reason: 'boolean' });

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test API').build(),
    );
    const openApi = JSON.stringify(document);
    expect(openApi).not.toContain(secretCanary);
    expect(openApi).not.toContain('NESTED_SECRET_CANARY');
    expect(openApi).toContain('secret-classified');
  });
});
