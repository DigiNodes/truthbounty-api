import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  RecomputeScoreOptions,
  SybilAppealRequestDto,
} from './sybil-resistance.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('sybil')
@Controller('sybil')
export class SybilResistanceController {
  constructor(
    private readonly sybilResistanceService: SybilResistanceService,
  ) {}

  /**
   * Compute and store a new Sybil score for a user
   */
  @Post('users/:userId/score')
  async recordScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.recordSybilScore(userId);
  }

  /**
   * Get the most recent Sybil score for a user
   */
  @Get('users/:userId/score')
  async getLatestScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getLatestSybilScore(userId);
  }

  /**
   * Get privacy-safe public view of Sybil score (strictly redacting sensitive data)
   */
  @Get('users/:userId/public-score')
  async getPublicScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getPublicSybilScore(userId);
  }

  /**
   * Deterministic recomputation path with optional pinned version and authority binding
   */
  @Post('users/:userId/recompute')
  async recomputeScore(
    @Param('userId') userId: string,
    @Body() options?: RecomputeScoreOptions,
  ) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.recomputeScore(userId, options);
  }

  /**
   * Submit an appeal against an unfavorable Sybil score evaluation
   */
  @Post('users/:userId/appeal')
  async submitAppeal(
    @Param('userId') userId: string,
    @Body() body: SybilAppealRequestDto,
  ) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    if (!body || !body.reason) {
      throw new BadRequestException('Appeal reason is required');
    }
    return this.sybilResistanceService.submitAppeal(userId, body);
  }

  /**
   * Get appeal history for a user
   */
  @Get('users/:userId/appeals')
  async getAppeals(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getAppeals(userId);
  }

  /**
   * Get a specific appeal by ID (owner or authorized reviewer only)
   */
  @Get('appeals/:appealId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a specific appeal (owner or reviewer only)' })
  async getAppealById(
    @Param('appealId') appealId: string,
    @CurrentUser() user: { id?: string; role?: string },
  ) {
    if (!appealId || appealId.trim() === '') {
      throw new BadRequestException('Appeal ID is required');
    }
    const requestingUserId = user?.id || '';
    const isReviewer =
      user?.role === 'admin' || user?.role === 'moderator';
    return this.sybilResistanceService.getAppealById(
      appealId,
      requestingUserId,
      isReviewer,
    );
  }

  /**
   * Review an appeal — admin/moderator only
   */
  @Post('appeals/:appealId/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Review an appeal (admin/moderator only)' })
  async reviewAppeal(
    @Param('appealId') appealId: string,
    @Body() body: { status: 'UPHELD' | 'RESOLVED' | 'REJECTED'; reviewNotes?: string },
    @CurrentUser() user: { id?: string },
  ) {
    if (!appealId || appealId.trim() === '') {
      throw new BadRequestException('Appeal ID is required');
    }
    if (!body?.status || !['UPHELD', 'RESOLVED', 'REJECTED'].includes(body.status)) {
      throw new BadRequestException('Valid status (UPHELD, RESOLVED, or REJECTED) is required');
    }
    return this.sybilResistanceService.reviewAppeal(
      appealId,
      user?.id || '',
      body.status,
      body.reviewNotes,
    );
  }

  /**
   * List appeals with filters — admin/moderator only
   */
  @Get('appeals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List appeals with filters (admin/moderator only)' })
  async listAppeals(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('modelVersion') modelVersion?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.sybilResistanceService.getAppealsWithFilters({
      status,
      userId,
      modelVersion,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
  }

  /**
   * List available Sybil score model versions
   */
  @Get('models')
  async getModels() {
    return this.sybilResistanceService.getModelVersions();
  }

  /**
   * Get Sybil score history for a user
   */
  @Get('users/:userId/history')
  async getScoreHistory(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreHistory(userId);
  }

  /**
   * Get Sybil score formatted for voting/verification engines
   */
  @Get('users/:userId/voting')
  async getScoreForVoting(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreForVoting(userId);
  }

  /**
   * Mark a user as Worldcoin verified
   */
  @Post('users/:userId/verify-worldcoin')
  async setWorldcoinVerified(
    @Param('userId') userId: string,
    @Body() body: { verified: boolean },
  ) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.setWorldcoinVerified(
      userId,
      body.verified,
    );
  }

  /**
   * Recalculate all Sybil scores (admin operation)
   */
  @Post('recalculate-all')
  async recalculateAll() {
    return this.sybilResistanceService.recalculateAllScores();
  }
}
