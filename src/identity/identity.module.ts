import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { WalletIdentityService } from './wallet-identity.service';
import { AuthSessionService } from './auth-session.service';
import { WalletIdentity } from './entities/wallet-identity.entity';
import { AuthSession } from './entities/auth-session.entity';
import { PrismaModule } from '../prisma/prisma.module';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';
import { AuthModule } from '../auth/auth.module';

/**
 * PREWAVE-BE-060 (#653): WalletIdentityService (normalized address+chain
 * binding, conflict-on-takeover) and AuthSessionService (hash-only session
 * tokens, rotation, revocation) are now registered and exported so the whole
 * app resolves the same identity/session boundary instead of the services
 * being orphaned outside the DI graph. AuditTrailService comes from the
 * global AuditModule.
 */
@Module({
  imports: [
    PrismaModule,
    SybilResistanceModule,
    AuthModule,
    TypeOrmModule.forFeature([WalletIdentity, AuthSession]),
  ],
  controllers: [IdentityController],
  providers: [IdentityService, WalletIdentityService, AuthSessionService],
  exports: [IdentityService, WalletIdentityService, AuthSessionService],
})
export class IdentityModule {}
