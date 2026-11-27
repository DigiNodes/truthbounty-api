import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GlobalAuthGuard } from '../auth/global-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';
import { SupportController } from './support.controller';
import { SupportRequestService } from './support.service';

describe('SupportController access policy', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const jwtGuard = {
      canActivate: (context: ExecutionContext) => {
        const req = context
          .switchToHttp()
          .getRequest<{ headers: { authorization?: string }; user?: AuthenticatedPrincipal }>();
        const principals: Record<string, AuthenticatedPrincipal> = {
          moderator: { address: '0xstaff', user: { role: 'moderator' } },
          admin: { address: '0xadmin', user: { role: 'admin' } },
          contributor: {
            address: '0xuser',
            user: { role: 'contributor' },
          },
        };
        const credential = req.headers.authorization?.replace('Bearer ', '');
        const principal = credential ? principals[credential] : undefined;

        if (!principal) throw new UnauthorizedException();
        req.user = principal;
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [SupportController],
      providers: [
        SupportRequestService,
        RolesGuard,
        { provide: JwtAuthGuard, useValue: jwtGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalGuards(new GlobalAuthGuard(app.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps submission public and returns no private fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/support/requests')
      .send({
        category: 'bug',
        contact: 'user@example.com',
        description: 'The application fails while opening my account page.',
        diagnostics: ['requestId: abc123'],
      })
      .expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'submitted',
        duplicate: false,
        reference: expect.any(String),
      }),
    );
    expect(response.body).not.toHaveProperty('contact');
    expect(response.body).not.toHaveProperty('description');
    expect(response.body).not.toHaveProperty('diagnostics');
  });

  it('denies anonymous and non-support enumeration and permits staff reads', async () => {
    await request(app.getHttpServer()).get('/support/requests').expect(401);
    await request(app.getHttpServer())
      .get('/support/requests')
      .set('Authorization', 'Bearer contributor')
      .expect(403);

    const response = await request(app.getHttpServer())
      .get('/support/requests')
      .set('Authorization', 'Bearer moderator')
      .expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toEqual(
      expect.objectContaining({
        contact: 'user@example.com',
        description: 'The application fails while opening my account page.',
        diagnostics: ['requestId: abc123'],
      }),
    );
  });

  it('denies anonymous arbitrary-ID retrieval', async () => {
    await request(app.getHttpServer())
      .get('/support/requests/arbitrary-id')
      .expect(401);
  });
});
