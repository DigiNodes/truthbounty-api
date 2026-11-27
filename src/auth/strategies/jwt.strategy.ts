import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { AuthenticatedPrincipal } from '../types/authenticated-request';
import { AUTH_GENERIC_FAILURE_MESSAGE } from '../../common/utils/timing-safe.util';

/**
 * The ordinary Passport strategy accepts only the application access-token
 * class. Capability tokens use a separate audience and validator.
 */
interface JwtPayload {
  address?: string;
  userId?: string | null;
  sub?: string;
  jti?: string;
  type?: string;
  aud?: string | string[];
  iss?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>(
        'JWT_SECRET',
        'truthbounty-secret-key-change-in-production',
      ),
      audience: configService.get<string>(
        'JWT_ACCESS_AUDIENCE',
        'truthbounty-api',
      ),
      issuer: configService.get<string>('JWT_ISSUER', 'truthbounty-api'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedPrincipal> {
    const expectedAudience = this.configService.get<string>(
      'JWT_ACCESS_AUDIENCE',
      'truthbounty-api',
    );
    const expectedIssuer = this.configService.get<string>(
      'JWT_ISSUER',
      'truthbounty-api',
    );
    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    if (
      payload.type !== 'access' ||
      !payload.jti ||
      !payload.address ||
      !/^0x[0-9a-f]{40}$/i.test(payload.address) ||
      !payload.sub ||
      !audiences.includes(expectedAudience) ||
      payload.iss !== expectedIssuer
    ) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }

    const user = await this.authService.validateToken(payload);
    if (!user) {
      throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
    }
    return user;
  }
}
