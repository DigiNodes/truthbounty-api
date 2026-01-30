import { Module } from '@nestjs/common';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistantVotingService } from './sybil-resistant-voting.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SybilResistanceController],
  providers: [SybilResistanceService, SybilResistantVotingService],
  exports: [SybilResistanceService, SybilResistantVotingService],
})
export class SybilResistanceModule {}
