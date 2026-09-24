import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { GovernanceCache } from './governance.cache';
import { Proposal, Vote } from './entities/proposal.entity';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Proposal, Vote]),
    CacheModule,
  ],
  controllers: [GovernanceController],
  providers: [GovernanceService, GovernanceCache],
  exports: [GovernanceService],
})
export class GovernanceModule {}
