import {
  Controller,
  Get,
  INestApplication,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth.service';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Controller('token-class')
class TokenClassTestController {
  @Get('user')
  @UseGuards(JwtAuthGuard)
  user() {
    return { ok: true };
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard)
  admin() {
    return { ok: true };
  }

  @Get('session')
  @UseGuards(JwtAuthGuard)
  session() {
    return { ok: true };
  }
}

describe('JwtStrategy access-token boundary', () => {
  let app: INestApplication;
  const secret = 'truthbounty-secret-key-change-in-production';
  let jwtService: JwtService;
  let validateToken: jest.Mock;

  beforeAll(async () => {
    validateToken = jest.fn().mockResolvedValue({
      address: `0x${'a'.repeat(40)}`,
      userId: 'user-1',
      user: null,
    });

    beforeEach(() => {
      validateToken.mockClear();
    });
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [TokenClassTestController],
      providers: [
        JwtAuthGuard,
        JwtStrategy,
        { provide: AuthService, useValue: { validateToken } },
        {
          provide: ConfigService,
          useValue: {
            get: (_key: string, defaultValue: string) => defaultValue,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    jwtService = new JwtService({ secret });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function sign(
    payload: Record<string, unknown>,
    claims: { audience?: string; issuer?: string } = {},
  ) {
    return jwtService.sign(payload, {
      expiresIn: 60,
      audience: 'truthbounty-api',
      issuer: 'truthbounty-api',
      ...claims,
    });
  }

  it('authenticates a valid ordinary access JWT', async () => {
    const token = sign({
      type: 'access',
      sub: 'user-1',
      address: `0x${'a'.repeat(40)}`,
      userId: 'user-1',
      jti: 'access-jti',
    });

    await request(app.getHttpServer())
      .get('/token-class/user')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });
    expect(validateToken).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access', jti: 'access-jti' }),
    );
  });

  it.each([
    ['wallet subject', `0x${'a'.repeat(40)}`],
    ['user subject', 'user-1'],
  ])('rejects a capability JWT with a %s on protected routes', async (_label, sub) => {
    const token = sign({
      type: 'capability',
      sub,
      address: `0x${'a'.repeat(40)}`,
      userId: sub === 'user-1' ? 'user-1' : null,
      jti: undefined,
    });

    for (const route of ['user', 'admin', 'session']) {
      await request(app.getHttpServer())
        .get(`/token-class/${route}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    expect(validateToken).not.toHaveBeenCalled();
  });

  it.each([
    ['missing type', { type: undefined }, {}],
    ['wrong audience', { type: 'access' }, { audience: 'other-api' }],
    ['wrong issuer', { type: 'access' }, { issuer: 'other-issuer' }],
  ])(
    'rejects access JWTs with %s',
    async (
      _label: string,
      extra: Record<string, unknown>,
      claims: { audience?: string; issuer?: string },
    ) => {
    const token = sign(
      {
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'access-jti',
        ...extra,
      },
      claims,
    );

    await request(app.getHttpServer())
      .get('/token-class/user')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    },
  );
});
