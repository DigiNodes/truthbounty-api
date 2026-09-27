import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { RewardsService } from './rewards.service';
import { CreateRewardDto } from './dto/create-reward.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * RewardsController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes  → PUBLIC (chain-derived reward projections are openly readable).
 * WRITE routes → ROLE(admin) only.
 *   Rationale: Reward records are projections of on-chain events. Any write through
 *   this API is a local projection update, not a protocol-authoritative settlement.
 *   Only admins may trigger such projection adjustments; the smart contract remains
 *   the sole source of truth for finalized reward state.
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('rewards')
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  // ── READ (public) ────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get all rewards' })
  @ApiResponse({ status: 200, description: 'List of rewards' })
  findAll() {
    return this.rewardsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get reward by ID' })
  @ApiParam({ name: 'id', description: 'Reward ID' })
  @ApiResponse({ status: 200, description: 'Reward details' })
  @ApiResponse({ status: 404, description: 'Reward not found' })
  findOne(@Param('id') id: string) {
    return this.rewardsService.findOne(+id);
  }

  // ── WRITE (admin only) ────────────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a reward projection (admin only)' })
  @ApiResponse({ status: 201, description: 'Reward created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  create(@Body() createRewardDto: CreateRewardDto) {
    return this.rewardsService.create(createRewardDto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a reward projection (admin only)' })
  @ApiParam({ name: 'id', description: 'Reward ID' })
  @ApiResponse({ status: 200, description: 'Reward updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  update(@Param('id') id: string, @Body() updateRewardDto: UpdateRewardDto) {
    return this.rewardsService.update(+id, updateRewardDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a reward projection (admin only)' })
  @ApiParam({ name: 'id', description: 'Reward ID' })
  @ApiResponse({ status: 200, description: 'Reward removed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  remove(@Param('id') id: string) {
    return this.rewardsService.remove(+id);
  }
}
