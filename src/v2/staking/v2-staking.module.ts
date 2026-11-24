import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Stake } from '../../staking/entities/stake.entity';
import { StakeEvent } from '../../staking/entities/stake-event.entity';
import { ProjectStakeLock } from '../../staking/entities/project-stake-lock.entity';
import { ProjectStakeWithdrawal } from '../../staking/entities/project-stake-withdrawal.entity';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectVerificationRound } from '../verification/entities/project-verification-round.entity';
import { ProjectDispute } from '../disputes/entities/project-dispute.entity';
import { StakeProjectionService } from './stake-projection.service';
import { StakeProjectionController } from './stake-projection.controller';
import { BlockchainModule } from '../../blockchain/blockchain.module';
import { FinalityPolicyModule } from '../../config/finality-policy.module';
import { AuthModule } from '../../auth/auth.module';

/**
 * PREWAVE-BE-065 — publish stake lock, unlock, slash, and withdrawal projections.
 *
 * Exposes read-only projections for available, locked, pending withdrawal, and slashed balances,
 * round locks, deadlines, and retryable payouts with exact 256-bit arithmetic and conservation digest.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Stake,
      StakeEvent,
      ProjectStakeLock,
      ProjectStakeWithdrawal,
      EventCheckpoint,
      ProjectVerificationRound,
      ProjectDispute,
    ]),
    BlockchainModule,
    FinalityPolicyModule,
    AuthModule,
  ],
  controllers: [StakeProjectionController],
  providers: [StakeProjectionService],
  exports: [StakeProjectionService],
})
export class V2StakingModule {}
