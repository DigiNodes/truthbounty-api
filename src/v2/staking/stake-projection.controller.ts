import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { StakeProjectionService } from './stake-projection.service';
import {
  StakeProjectionResponseDto,
  StakePayoutDto,
} from './dto/stake-projection-response.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

@ApiTags('v2-staking')
@Controller('v2/staking')
export class StakeProjectionController {
  constructor(private readonly stakeProjectionService: StakeProjectionService) {}

  @Get('projections/:walletAddress')
  @ApiOperation({
    summary: 'Get published stake lock, unlock, slash, and withdrawal projections for a wallet',
  })
  @ApiParam({ name: 'walletAddress', description: 'Wallet address of the staker' })
  @ApiQuery({ name: 'chainId', required: false, type: Number })
  @ApiQuery({ name: 'claimId', required: false, type: String })
  @ApiQuery({ name: 'maxLagBlocks', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Stake projections with exact 256-bit balances and custody conservation digest',
    type: StakeProjectionResponseDto,
  })
  async getWalletProjection(
    @Param('walletAddress') walletAddress: string,
    @Query('chainId') chainId?: string,
    @Query('claimId') claimId?: string,
    @Query('maxLagBlocks') maxLagBlocks?: string,
  ): Promise<StakeProjectionResponseDto> {
    return this.stakeProjectionService.getWalletStakeProjection(walletAddress, {
      chainId: chainId ? Number(chainId) : undefined,
      claimId,
      maxLagBlocks: maxLagBlocks ? Number(maxLagBlocks) : undefined,
    });
  }

  @Get('projections/:walletAddress/claims/:claimId')
  @ApiOperation({
    summary: 'Get published stake projection for a specific wallet and project claim',
  })
  @ApiParam({ name: 'walletAddress', description: 'Wallet address of the staker' })
  @ApiParam({ name: 'claimId', description: 'Project claim ID' })
  @ApiQuery({ name: 'chainId', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Claim-scoped stake projections with round locks and conservation',
    type: StakeProjectionResponseDto,
  })
  async getWalletClaimProjection(
    @Param('walletAddress') walletAddress: string,
    @Param('claimId') claimId: string,
    @Query('chainId') chainId?: string,
  ): Promise<StakeProjectionResponseDto> {
    return this.stakeProjectionService.getWalletStakeProjection(walletAddress, {
      chainId: chainId ? Number(chainId) : undefined,
      claimId,
    });
  }

  @Post('payouts/:payoutId/retry')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Safely retry a failed stake payout or withdrawal without double-debiting funds',
  })
  @ApiParam({ name: 'payoutId', description: 'Payout ID' })
  @ApiResponse({
    status: 200,
    description: 'Retry result of payout',
    type: StakePayoutDto,
  })
  async retryPayout(
    @Param('payoutId') payoutId: string,
    @Body() body?: { simulateSuccess?: boolean; newTxHash?: string },
  ) {
    return this.stakeProjectionService.retryPayout(payoutId, body);
  }
}
