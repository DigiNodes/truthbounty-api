import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ProjectStakeService } from './project-stake.service';
import { CreateStakeLockDto } from './dto/create-stake-lock.dto';
import { CreateStakeWithdrawalDto } from './dto/create-stake-withdrawal.dto';
import { EntitlementBreakdown } from './project-stake.service';

@Controller('staking/projects')
export class StakingController {
  constructor(private readonly stakeService: ProjectStakeService) {}

  /** Current entitlement breakdown for a wallet+project claim */
  @Get(':claimId/entitlement')
  async entitlement(
    @Param('claimId') claimId: string,
    @Query('walletAddress') walletAddress: string,
  ): Promise<EntitlementBreakdown> {
    return this.stakeService.getEntitlement(walletAddress, claimId);
  }

  /** Create a time-locked portion of a stake */
  @Post(':claimId/locks')
  async createLock(
    @Param('claimId') claimId: string,
    @Body() dto: CreateStakeLockDto,
  ) {
    try {
      return await this.stakeService.createLock({
        walletAddress: dto.walletAddress,
        claimId,
        amount: dto.amount,
        unlocksAt: dto.unlocksAt,
        reason: dto.reason,
      });
    } catch (err) {
      throw new ConflictException(
        (err as Error).message || 'unable to create stake lock',
      );
    }
  }

  /** Record an idempotent project-stake withdrawal */
  @Post(':claimId/withdrawals')
  async withdraw(
    @Param('claimId') claimId: string,
    @Body() dto: CreateStakeWithdrawalDto,
  ) {
    const result = await this.stakeService.withdraw({
      walletAddress: dto.walletAddress,
      claimId,
      amount: dto.amount,
      txHash: dto.txHash,
      blockNumber: dto.blockNumber,
    });

    if (!result.applied) {
      throw new ConflictException(`withdrawal not applied (${result.reason})`);
    }
    return result;
  }

  /** Reconcile the local stake projection against an observed on-chain total */
  @Post(':claimId/reconcile')
  async reconcile(
    @Param('claimId') claimId: string,
    @Body() body: { walletAddress: string; observedTotal: string },
  ) {
    const result = await this.stakeService.reconcile(
      body.walletAddress,
      claimId,
      body.observedTotal,
    );
    return result;
  }

  /** Fetch a wallet's stake for a claim, or 404 */
  @Get(':claimId/stake')
  async stake(
    @Param('claimId') claimId: string,
    @Query('walletAddress') walletAddress: string,
  ) {
    try {
      return await this.stakeService.getStakeOrThrow(walletAddress, claimId);
    } catch (err) {
      throw new NotFoundException((err as Error).message);
    }
  }
}
