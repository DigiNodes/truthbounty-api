import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { AuthenticatedPrincipal } from '../types/authenticated-request';

/**
 * Jailed JWT payload contract -- the minimal shape the strategy
 * accepts from the verified token. Fields are optional because
 * tokens are issued by multiple code paths; the strategy fails closed
 * if no principal can be resolved.
 */
interface JwtPayload {
  address?: string;
  userId?: string;
  sub?: string;
  jti?: string;
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
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedPrincipal> {
    const user = await this.authService.validateToken(payload);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
