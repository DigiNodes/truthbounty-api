import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimProjectorService } from './claim-projector.service';
import { ClaimState } from '../domain/claim/claimState';

@Controller('claims/read-model')
export class ClaimLifecycleController {
  constructor(private readonly projector: ClaimProjectorService) {}

  /**
   * Fetch the projected on-chain claim lifecycle read model.
   */
  @Get(':claimId')
  async getReadModel(
    @Param('claimId') claimId: string,
    @Query('chainId') chainId = '10',
  ): Promise<ClaimReadModel> {
    const model = await this.projector.getReadModel(claimId, chainId);
    if (!model) {
      throw new NotFoundException(
        `No projected read model for claim ${claimId} on chain ${chainId}`,
      );
    }
    return model;
  }

  /**
   * Manually (re)project a claim from its persisted event history. Used for
   * backfill and drift repair.
   */
  @Post(':claimId/reproject')
  async reproject(
    @Param('claimId') claimId: string,
    @Query('chainId') chainId = '10',
  ): Promise<{ claimId: string; state: ClaimState }> {
    const state = await this.projector.reproject(claimId, chainId);
    return { claimId, state };
  }
}
