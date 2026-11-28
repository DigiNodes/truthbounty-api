import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { rejectLegacyProtocolOperation } from './protocol-authority';

@Controller('claims/read-model')
export class ClaimLifecycleController {
  @Get(':claimId')
  @ApiOperation({ summary: 'Deprecated legacy claim read model', deprecated: true })
  @ApiResponse({ status: 410, description: 'Use canonical claim read models' })
  getReadModel(
    @Param('claimId') _claimId: string,
    @Query('chainId') _chainId = '10',
  ): never {
    return rejectLegacyProtocolOperation(
      'This legacy claim projection is retired. Use /api/v2/claim-read-models/{claimId}.',
    );
  }

  @Post(':claimId/reproject')
  @ApiOperation({ summary: 'Deprecated legacy claim reprojection', deprecated: true })
  @ApiResponse({ status: 410, description: 'Use the canonical event projector' })
  reproject(
    @Param('claimId') _claimId: string,
    @Query('chainId') _chainId = '10',
  ): never {
    return rejectLegacyProtocolOperation(
      'Legacy event history cannot be reprojected as canonical state. Use the approved canonical event ingestion pipeline.',
    );
  }
}
