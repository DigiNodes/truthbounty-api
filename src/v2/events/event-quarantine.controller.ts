import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminRole } from '../../admin/entities/admin.entity';
import { Roles } from '../../admin/decorators/roles.decorator';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { RolesGuard } from '../../admin/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import {
  QuarantineListDto,
  QuarantineListQueryDto,
  QuarantineRecordDto,
  ReplayQuarantineRequestDto,
  ReplayQuarantineResponseDto,
} from './event-quarantine.dto';
import { EventQuarantineService } from './event-quarantine.service';
import { EventQuarantineReplayService } from './event-quarantine-replay.service';

const READ_ROLES = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.SECURITY_ANALYST,
  AdminRole.AUDITOR,
];

/**
 * Admin-plane inspection and reviewed replay for unknown/undecodable contract
 * events (PREWAVE-BE-053, #647).
 *
 * Reads never expose the raw payload or free-form decoder detail. Replay is
 * authorized, idempotent and audited; it reuses the canonical ingest path so it
 * cannot create a second protocol mutation.
 */
@ApiTags('Event Quarantine')
@ApiBearerAuth('JWT-auth')
@Controller('v2/admin/events/quarantine')
@UseGuards(JwtAuthGuard, AdminGuard, RolesGuard)
export class EventQuarantineController {
  constructor(
    private readonly quarantine: EventQuarantineService,
    private readonly replay: EventQuarantineReplayService,
  ) {}

  @Get()
  @Roles(...READ_ROLES)
  @ApiOperation({ summary: 'List quarantined contract events (privacy-safe)' })
  @ApiOkResponse({ type: QuarantineListDto })
  @ApiResponse({ status: 403, description: 'Admin access required.' })
  async list(
    @Query() query: QuarantineListQueryDto,
  ): Promise<QuarantineListDto> {
    return this.quarantine.list(query);
  }

  @Get(':id')
  @Roles(...READ_ROLES)
  @ApiOperation({ summary: 'Get one quarantined event (privacy-safe)' })
  @ApiParam({ name: 'id', description: 'Quarantine record id.' })
  @ApiOkResponse({ type: QuarantineRecordDto })
  @ApiResponse({ status: 404, description: 'Unknown quarantine record.' })
  get(@Param('id') id: string): Promise<QuarantineRecordDto> {
    return this.quarantine.get(id);
  }

  @Post(':id/replay')
  @Idempotent()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({
    summary: 'Replay a quarantined log against the current approved artifact',
  })
  @ApiParam({ name: 'id', description: 'Quarantine record id.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Duplicate replay of an already-replayed row is a no-op.',
  })
  @ApiOkResponse({ type: ReplayQuarantineResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Artifact not ready / still undecodable.',
  })
  async replayOne(
    @Param('id') id: string,
    @Body() body: ReplayQuarantineRequestDto,
    @Req() req: { admin?: { id?: string } },
  ): Promise<ReplayQuarantineResponseDto> {
    const actorId = req.admin?.id;
    if (!actorId) {
      throw new UnauthorizedException('Admin identity is required for replay');
    }
    return this.replay.replay(id, {
      actorId,
      reason: body.reason,
      expectedArtifactVersion: body.expectedArtifactVersion,
    });
  }
}
