import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistantVotingService } from './sybil-resistant-voting.service';
import { SybilModelRegistry } from './sybil-model-registry';
import { SybilProvenanceService } from './sybil-provenance.service';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { StakeEvent } from '../staking/entities/stake-event.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    TypeOrmModule.forFeature([StakeEvent]),
    // AuthModule exports JwtAuthGuard, AdminGuard, and RolesGuard so the
    // controller's per-route guards can be injected without a circular dep.
    AuthModule,
  ],
  controllers: [SybilResistanceController],
  providers: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
    SybilOwnershipGuard,
  ],
  exports: [
    SybilResistanceService,
    SybilResistantVotingService,
    SybilModelRegistry,
    SybilProvenanceService,
  ],
})
export class SybilResistanceModule {}
