import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
  ForbiddenException,
  Query,
  UseGuards,
  NotFoundException,
  Logger,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  RecomputeScoreOptions,
  SybilAppealRequestDto,
} from './sybil-resistance.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';

/**
 * SybilResistanceController — authorization matrix:
 *
 * GET  public-score / history / voting / models  → PUBLIC
 * GET  users/:userId/score                       → AUTHN
 * GET  users/:userId/appeals                     → AUTHN + OWNERSHIP
 * GET  appeals/:appealId                         → AUTHN (service checks ownership)
 * GET  appeals                                   → ROLE(admin, moderator)
 * POST users/:userId/score                       → ADMIN
 * POST users/:userId/recompute                   → ADMIN
 * POST recalculate-all                           → ADMIN
 * POST users/:userId/appeal                      → AUTHN + OWNERSHIP
 * POST appeals/:appealId/review                  → ROLE(admin, moderator)
 * POST users/:userId/verify-worldcoin            → REMOVED (410 Gone)
 */
@ApiTags('sybil')
@Controller('sybil')
export class SybilResistanceController {
  private readonly logger = new Logger(SybilResistanceController.name);

  constructor(
    private readonly sybilResistanceService: SybilResistanceService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // READ — PUBLIC
  // ─────────────────────────────────────────────────────────────────────────

  @Get('users/:userId/public-score')
  @ApiOperation({ summary: 'Get privacy-safe public Sybil score (public)' })
  async getPublicScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getPublicSybilScore(userId);
  }

  @Get('users/:userId/history')
  @ApiOperation({ summary: 'Get Sybil score history (public)' })
  async getScoreHistory(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreHistory(userId);
  }

  @Get('users/:userId/voting')
  @ApiOperation({ summary: 'Get Sybil score for voting engines (public)' })
  async getScoreForVoting(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreForVoting(userId);
  }

  @Get('models')
  @ApiOperation({ summary: 'List available scoring model versions (public)' })
  async getModels() {
    return this.sybilResistanceService.getModelVersions();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // READ — AUTHENTICATED
  // ─────────────────────────────────────────────────────────────────────────

  @Get('users/:userId/score')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get latest Sybil score (authenticated)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async getLatestScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getLatestSybilScore(userId);
  }

  /** Owner may view their own appeal history. */
  @Get('users/:userId/appeals')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get appeal history (own account only)' })
  @ApiResponse({ status: 403, description: 'May only view own appeals' })
  async getAppeals(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getAppeals(userId);
  }

  /** Owner or reviewer may fetch a single appeal by ID. */
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

  /** Admin / moderator may list all appeals with filters. */
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

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — ADMIN ONLY
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Score recording is ADMIN only — any authenticated user being able to
   * trigger score writes for arbitrary user IDs allows score manipulation.
   */
  @Post('users/:userId/score')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record Sybil score for a user (admin only)' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  async recordScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.recordSybilScore(userId);
  }

  /**
   * Recomputation is ADMIN only — it can pin specific model versions and
   * override fail-closed options, making it a privileged scoring operation.
   */
  @Post('users/:userId/recompute')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recompute Sybil score with options (admin only)' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  async recomputeScore(
    @Param('userId') userId: string,
    @Body() options?: RecomputeScoreOptions,
  ) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.recomputeScore(userId, options);
  }

  /** Bulk recalculation is ADMIN only and audit-logged. */
  @Post('recalculate-all')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recalculate all Sybil scores (admin only)' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  async recalculateAll(
    @Request() req: { user?: { sub?: string; userId?: string } },
  ) {
    const actorId = req.user?.sub ?? req.user?.userId ?? 'unknown';
    this.logger.log(
      `sybil.bulk_recalculate initiated by admin actor [actor=${actorId}]`,
    );
    return this.sybilResistanceService.recalculateAllScores();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — ADMIN / MODERATOR
  // ─────────────────────────────────────────────────────────────────────────

  /** Admin / moderator may review an appeal. */
  @Post('appeals/:appealId/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'moderator')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Review an appeal (admin/moderator only)' })
  async reviewAppeal(
    @Param('appealId') appealId: string,
    @Body()
    body: {
      status: 'UPHELD' | 'RESOLVED' | 'REJECTED';
      reviewNotes?: string;
    },
    @CurrentUser() user: { id?: string },
  ) {
    if (!appealId || appealId.trim() === '') {
      throw new BadRequestException('Appeal ID is required');
    }
    if (
      !body?.status ||
      !['UPHELD', 'RESOLVED', 'REJECTED'].includes(body.status)
    ) {
      throw new BadRequestException(
        'Valid status (UPHELD, RESOLVED, or REJECTED) is required',
      );
    }
    return this.sybilResistanceService.reviewAppeal(
      appealId,
      user?.id || '',
      body.status,
      body.reviewNotes,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE — SELF-SERVICE (AUTHENTICATED + OWNERSHIP)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Users may appeal only their own account. SybilOwnershipGuard ensures
   * :userId matches the JWT subject — user IDs in the path cannot override
   * the authenticated principal.
   */
  @Post('users/:userId/appeal')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a Sybil score appeal (own account only)' })
  @ApiResponse({ status: 403, description: 'May only appeal your own account' })
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

  // ─────────────────────────────────────────────────────────────────────────
  // REMOVED ENDPOINT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * REMOVED — accepted a caller-supplied boolean that mutated Worldcoin
   * verification state without proof verification.
   * Use POST /identity/worldcoin/verify with a ZK proof.
   */
  @Post('users/:userId/verify-worldcoin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'REMOVED — Worldcoin verification is proof-derived only',
    deprecated: true,
  })
  @ApiResponse({
    status: 410,
    description:
      'Permanently removed. Use POST /identity/worldcoin/verify.',
  })
  async setWorldcoinVerified(
    @Param('userId') _userId: string,
    @Body() _body: unknown,
  ) {
    throw new ForbiddenException(
      'This endpoint has been permanently removed. ' +
        'Worldcoin verification status is derived from proof submission only. ' +
        'Use POST /identity/worldcoin/verify to submit a Worldcoin ZK proof.',
    );
  }
}
