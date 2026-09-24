import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { SiweService } from './services/siwe.service';
import { TokenService } from './services/token.service';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { ServiceAuthGuard } from './guards/service-auth.guard';

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'truthbounty-secret-key-change-in-production'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION', '15m') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SiweService,
    TokenService,
    JwtStrategy,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    AdminGuard,
    ServiceAuthGuard,
  ],
  exports: [
    AuthService,
    SiweService,
    TokenService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    AdminGuard,
    ServiceAuthGuard,
    PassportModule,
  ],
})
export class AuthModule {}
