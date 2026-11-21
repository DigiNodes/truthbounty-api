import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrepareEvidenceUploadDto } from './dto/prepare-evidence-upload.dto';
import { EvidenceUploadPreparationService } from './evidence-upload-preparation.service';

/**
 * Non-authoritative support endpoint. It only pins content on IPFS and returns
 * a preparation receipt. It never reports protocol registration and writes no
 * claim/evidence/evidence-version row.
 */
@ApiTags('claims')
@Controller('claims')
export class EvidenceUploadController {
  constructor(private readonly preparation: EvidenceUploadPreparationService) {}

  @Post(':claimId/evidence/upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Prepare (pin) IPFS content for a canonical claim — non-authoritative',
    description:
      'Uploads and pins content for an already projected canonical claim. The response is a preparation receipt with onChainRegistered=false and evidenceRegistered=false. Registration/replacement requires a user-signed contract transaction followed by a finalized canonical event.',
  })
  @ApiParam({
    name: 'claimId',
    description: 'Canonical claim id from the V2 projection',
  })
  @ApiResponse({
    status: 202,
    description: 'IPFS content prepared; no on-chain registration occurred',
  })
  @ApiResponse({ status: 400, description: 'Invalid claim id or content' })
  @ApiResponse({
    status: 404,
    description: 'Canonical claim is not projected yet',
  })
  @ApiResponse({
    status: 422,
    description: 'Secret material detected or IPFS failed',
  })
  async prepareUpload(
    @Param('claimId') claimId: string,
    @Body() dto: PrepareEvidenceUploadDto,
  ) {
    return this.preparation.prepare(claimId, dto);
  }
}
