import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Stake } from './entities/stake.entity';
import { StakeEvent } from './entities/stake-event.entity';
import { ProjectStakeLock } from './entities/project-stake-lock.entity';
import { ProjectStakeWithdrawal } from './entities/project-stake-withdrawal.entity';
import { StakingSyncService } from './staking-sync.service';
import { ProjectStakeService } from './project-stake.service';
import { StakingController } from './staking.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Stake,
      StakeEvent,
      ProjectStakeLock,
      ProjectStakeWithdrawal,
    ]),
  ],
  controllers: [StakingController],
  providers: [StakingSyncService, ProjectStakeService],
  exports: [StakingSyncService, ProjectStakeService],
})
export class StakingModule {}
