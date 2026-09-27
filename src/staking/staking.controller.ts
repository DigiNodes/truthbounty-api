import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProjectStakeService } from './project-stake.service';
import { CreateStakeLockDto } from './dto/create-stake-lock.dto';
import { CreateStakeWithdrawalDto } from './dto/create-stake-withdrawal.dto';
import { EntitlementBreakdown } from './project-stake.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * StakingController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes → PUBLIC (entitlement/stake are chain-derived projections).
 * LOCK / WITHDRAWAL → AUTHN (any authenticated user — wallet-holder submitting
 *   chain-confirmed events to be indexed; the API records, never authorizes).
 * RECONCILE → ROLE(admin) only.
 *   Rationale: reconcile() corrects local projection drift against an observed
 *   on-chain total. This is an operator recovery action, not a user action.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('staking')
@Controller('staking/projects')
export class StakingController {
  constructor(private readonly stakeService: ProjectStakeService) {}

  // ── READ (public) ─────────────────────────────────────────────────────────

  @Get(':claimId/entitlement')
  @ApiOperation({ summary: 'Current entitlement breakdown for a wallet+project claim' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiQuery({ name: 'walletAddress', required: true })
  @ApiResponse({ status: 200, description: 'Entitlement breakdown' })
  async entitlement(
    @Param('claimId') claimId: string,
    @Query('walletAddress') walletAddress: string,
  ): Promise<EntitlementBreakdown> {
    return this.stakeService.getEntitlement(walletAddress, claimId);
  }

  @Get(':claimId/stake')
  @ApiOperation({ summary: "Fetch a wallet's stake for a claim" })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiQuery({ name: 'walletAddress', required: true })
  @ApiResponse({ status: 200, description: 'Stake record' })
  @ApiResponse({ status: 404, description: 'Stake not found' })
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

  // ── WRITE — authenticated users ───────────────────────────────────────────

  @Post(':claimId/locks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a time-locked portion of a stake' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Lock created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Conflict' })
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

  @Post(':claimId/withdrawals')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record an idempotent project-stake withdrawal' })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Withdrawal recorded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 409, description: 'Withdrawal not applied' })
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

  // ── RECONCILE — admin only ────────────────────────────────────────────────

  @Post(':claimId/reconcile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reconcile local stake projection against observed on-chain total (admin only)',
  })
  @ApiParam({ name: 'claimId', description: 'Claim ID' })
  @ApiResponse({ status: 201, description: 'Reconciliation result' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  async reconcile(
    @Param('claimId') claimId: string,
    @Body() body: { walletAddress: string; observedTotal: string },
  ) {
    return this.stakeService.reconcile(
      body.walletAddress,
      claimId,
      body.observedTotal,
    );
  }
}
