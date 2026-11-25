
import { Controller, Get, GoneException } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('rewards')
@Controller('rewards')
export class RewardsController {
  private readonly deprecationMessage =
    'The legacy rewards API has been deprecated. Reward data must be read from the V2 canonical projections. Use GET /api/v2/claims/{claimId}/rewards with the appropriate chain context. The legacy collection and ID-based endpoints have no direct V2 equivalent.';

  @Get()
  @ApiOperation({
    summary: 'Deprecated legacy rewards collection',
    description:
      'This legacy endpoint is deprecated. Use the V2 claim reward projection where applicable.',
    deprecated: true,
  })
  @ApiResponse({
    status: 410,
    description: 'The legacy rewards endpoint has been permanently deprecated.',
  })
  findAll(): never {
    throw new GoneException(this.deprecationMessage);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Deprecated legacy reward lookup',
    description:
      'This legacy endpoint is deprecated. There is no direct V2 equivalent for the legacy reward ID.',
    deprecated: true,
  })
  @ApiResponse({
    status: 410,
    description: 'The legacy rewards endpoint has been permanently deprecated.',
  })
  findOne(): never {
    throw new GoneException(this.deprecationMessage);
  }
}
