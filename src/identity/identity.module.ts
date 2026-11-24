import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SybilResistanceModule } from '../sybil-resistance/sybil-resistance.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, SybilResistanceModule, AuthModule],
  controllers: [IdentityController],
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
