import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { WalletLinkChallengeService } from './wallet-link-challenge.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, SybilResistanceModule, AuthModule],
  controllers: [IdentityController],
  providers: [IdentityService, WalletLinkChallengeService],
  exports: [IdentityService, WalletLinkChallengeService],
})
export class IdentityModule {}
