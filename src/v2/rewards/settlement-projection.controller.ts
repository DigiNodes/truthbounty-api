import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { SettlementProjectionService } from './settlement-projection.service';
import { SettlementProjectionResponseDto } from './dto/settlement-projection-response.dto';

@ApiTags('v2-settlement', 'v2-rewards')
@Controller()
export class SettlementProjectionController {
  constructor(private readonly projectionService: SettlementProjectionService) {}

  @Get([
    'v2/claims/:claimId/settlement',
    'api/v2/claims/:claimId/settlement',
    'v2/claims/:claimId/rewards',
    'api/v2/claims/:claimId/rewards',
  ])
  @ApiOperation({
    summary: 'Exact reward, claimable, and settlement projections',
    description:
      'Returns exact 256-bit integer accounting for funded, accrued, claimed, ' +
      'claimable, pending, slashed, refunded, and dust values, with asset metadata, ' +
      'finality state, and provenance binding. Strictly non-authoritative; fails closed on stale state.',
  })
  @ApiParam({ name: 'claimId', description: 'Claim UUID or bytes32 identifier' })
  @ApiQuery({ name: 'chainId', required: false, description: 'EVM Chain ID (default 11155420)' })
  @ApiResponse({
    status: 200,
    description: 'Exact settlement and reward projection',
    type: SettlementProjectionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid claimId or unsupported chainId',
  })
  @ApiResponse({
    status: 404,
    description: 'Claim not found',
  })
  @ApiResponse({
    status: 409,
    description: 'Stale reconciliation: indexer lag exceeds freshness threshold (fail closed)',
  })
  async getSettlement(
    @Param('claimId') claimId: string,
    @Query('chainId') chainId?: string,
  ): Promise<SettlementProjectionResponseDto> {
    const parsedChainId = chainId ? parseInt(chainId, 10) : undefined;
    return this.projectionService.getClaimSettlementProjection(claimId, {
      chainId: parsedChainId,
    });
  }
}
