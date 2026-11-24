import {
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimProjectorService } from './claim-projector.service';
import { ClaimState } from '../domain/claim/claimState';
import {
  ClaimBadProjectionError,
  ClaimNotFoundError,
} from './errors/claim-lifecycle.errors';

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
      throw new ClaimNotFoundError({ claimId, chainId });
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
    try {
      const state = await this.projector.reproject(claimId, chainId);
      return { claimId, state };
    } catch (error) {
      // Translate any low-level projection failure into a typed, client-safe
      // domain error. We never leak the underlying message or stack.
      if (error instanceof ClaimBadProjectionError) {
        throw error;
      }
      throw new ClaimBadProjectionError({ claimId, chainId });
    }
  }
}
