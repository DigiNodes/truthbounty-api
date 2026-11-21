import { Injectable } from '@nestjs/common';
import { ClaimReadModelService } from '../v2/read-models/claim-read-model.service';
import { CanonicalClaimIdentityPort } from './evidence-upload-preparation.service';

/**
 * Binds IPFS preparation to a canonical claim identity that is already visible
 * in the finalized V2 projection. Unknown, delayed, quarantined or reorged
 * claims are not projected and therefore fail closed with the read model's
 * documented NOT_FOUND / STALE_RECONCILIATION response.
 */
@Injectable()
export class ProjectionClaimIdentityValidator implements CanonicalClaimIdentityPort {
  constructor(private readonly readModels: ClaimReadModelService) {}

  async assertCanonicalClaim(claimId: string): Promise<void> {
    await this.readModels.getDetail(claimId);
  }
}
