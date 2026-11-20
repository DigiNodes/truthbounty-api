import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { SybilResistanceService } from './sybil-resistance.service';
import { SybilProvenanceService } from './sybil-provenance.service';
import {
  PublicSybilScoreView,
  RecomputeScoreOptions,
  SanitizedSybilAppealDto,
  SanitizedSybilScoreComputationResult,
  SanitizedSybilScoreDto,
  SybilAppealRequestDto,
  SybilVotingScoreDto,
} from './sybil-resistance.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ServiceAuthGuard } from '../auth/guards/service-auth.guard';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';

@ApiTags('sybil')
@Controller('sybil')
export class SybilResistanceController {
  private readonly provenanceService: SybilProvenanceService;

  constructor(
    private readonly sybilResistanceService: SybilResistanceService,
    @Optional() provenanceService?: SybilProvenanceService,
  ) {
    this.provenanceService = provenanceService || new SybilProvenanceService();
  }

  /**
   * Helper to assert caller owns the resource or has privileged role
   */
  private assertOwnershipOrPrivileged(
    userId: string,
    caller?: AuthenticatedPrincipal,
  ): void {
    if (!caller) {
      return; // If not provided in unit test, guard handles it in HTTP layer
    }
    const callerId = caller.userId || caller.user?.id;
    const role = caller.user?.role;
    const isOwner =
      callerId !== undefined && callerId !== null && callerId === userId;
    const isPrivileged = role === 'admin' || role === 'moderator';

    if (!isOwner && !isPrivileged) {
      throw new ForbiddenException(
        'Access denied: You do not have permission to access this user\'s Sybil data',
      );
    }
  }

  private validateUserId(userId: string): void {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
  }

  /**
   * Compute and store a new Sybil score for a user
   */
  @Post('users/:userId/score')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Compute and store a new Sybil score for a user' })
  async recordScore(
    @Param('userId') userId: string,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ) {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);
    const score = await this.sybilResistanceService.recordSybilScore(userId);
    return this.provenanceService.toSanitizedScoreDto(score);
  }

  /**
   * Get the most recent Sybil score for a user
   * Guarded: Owner or Moderator/Admin only. Returns sanitized DTO.
   */
  @Get('users/:userId/score')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get latest sanitized Sybil score for user' })
  @ApiResponse({ status: 200, description: 'Latest sanitized Sybil score' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async getLatestScore(
    @Param('userId') userId: string,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ): Promise<SanitizedSybilScoreDto> {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);
    const score = await this.sybilResistanceService.getLatestSybilScore(userId);
    return this.provenanceService.toSanitizedScoreDto(score);
  }

  /**
   * Get privacy-safe public view of Sybil score (strictly redacting sensitive data)
   * Explicitly and intentionally PUBLIC endpoint.
   */
  @Get('users/:userId/public-score')
  @ApiOperation({
    summary: 'Get privacy-safe public view of Sybil score (strictly sanitized)',
  })
  @ApiResponse({ status: 200, description: 'Sanitized public score view' })
  async getPublicScore(
    @Param('userId') userId: string,
  ): Promise<PublicSybilScoreView> {
    this.validateUserId(userId);
    return this.sybilResistanceService.getPublicSybilScore(userId);
  }

  /**
   * Deterministic recomputation path with optional pinned version and authority binding
   */
  @Post('users/:userId/recompute')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Deterministic score recomputation' })
  async recomputeScore(
    @Param('userId') userId: string,
    @Body() options?: RecomputeScoreOptions,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ): Promise<SanitizedSybilScoreComputationResult> {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);
    const res = await this.sybilResistanceService.recomputeScore(
      userId,
      options,
    );
    return this.provenanceService.toSanitizedScoreComputationResult(res);
  }

  /**
   * Submit an appeal against an unfavorable Sybil score evaluation
   */
  @Post('users/:userId/appeal')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit an appeal against Sybil score' })
  async submitAppeal(
    @Param('userId') userId: string,
    @Body() body: SybilAppealRequestDto,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ): Promise<SanitizedSybilAppealDto> {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);
    if (!body || !body.reason || body.reason.trim() === '') {
      throw new BadRequestException('Appeal reason is required');
    }
    const record = await this.sybilResistanceService.submitAppeal(userId, body);
    return this.provenanceService.toSanitizedAppealDto(record);
  }

  /**
   * Get appeal history for a user (Owner or Moderator/Admin only)
   */
  @Get('users/:userId/appeals')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get appeal history for a user' })
  async getAppeals(
    @Param('userId') userId: string,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ): Promise<SanitizedSybilAppealDto[]> {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);
    const appeals = await this.sybilResistanceService.getAppeals(userId);
    return (appeals || []).map((a) =>
      this.provenanceService.toSanitizedAppealDto(a),
    );
  }

  /**
   * List available Sybil score model versions (Public)
   */
  @Get('models')
  @ApiOperation({ summary: 'List available Sybil score model versions' })
  async getModels() {
    return this.sybilResistanceService.getModelVersions();
  }

  /**
   * Get Sybil score history for a user (Owner or Moderator/Admin only)
   * Uses bounded pagination to prevent bulk enumeration
   */
  @Get('users/:userId/history')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Sybil score history with bounded pagination' })
  async getScoreHistory(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @CurrentUser() caller?: AuthenticatedPrincipal,
  ): Promise<SanitizedSybilScoreDto[]> {
    this.validateUserId(userId);
    this.assertOwnershipOrPrivileged(userId, caller);

    // Enforce safe bounds on pagination to prevent bulk enumeration
    const safeLimit =
      limit !== undefined
        ? Math.min(Math.max(1, Number(limit) || 10), 50)
        : undefined;
    const safeOffset =
      offset !== undefined ? Math.max(0, Number(offset) || 0) : undefined;

    const history =
      safeLimit !== undefined || safeOffset !== undefined
        ? await this.sybilResistanceService.getSybilScoreHistory(
            userId,
            safeLimit,
            safeOffset,
          )
        : await this.sybilResistanceService.getSybilScoreHistory(userId);

    return (history || []).map((h) =>
      this.provenanceService.toSanitizedScoreDto(h),
    );
  }

  /**
   * Get Sybil score formatted for voting/verification engines
   * RESTRICTED: Internal-service-only via ServiceAuthGuard (x-service-api-key)
   * Returns minimal verification DTO without raw calculation details or provenance
   */
  @Get('users/:userId/voting')
  @UseGuards(ServiceAuthGuard)
  @ApiHeader({
    name: 'x-service-api-key',
    description: 'Internal service API key',
  })
  @ApiOperation({
    summary: 'Get minimal Sybil score for internal voting service',
  })
  async getScoreForVoting(
    @Param('userId') userId: string,
  ): Promise<SybilVotingScoreDto> {
    this.validateUserId(userId);
    const votingScore =
      await this.sybilResistanceService.getSybilScoreForVoting(userId);
    return this.provenanceService.toVotingScoreDto(votingScore);
  }

  /**
   * Mark a user as Worldcoin verified (Admin only)
   */
  @Post('users/:userId/verify-worldcoin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark a user as Worldcoin verified (admin only)' })
  async setWorldcoinVerified(
    @Param('userId') userId: string,
    @Body() body: { verified: boolean },
  ) {
    this.validateUserId(userId);
    return this.sybilResistanceService.setWorldcoinVerified(
      userId,
      body.verified,
    );
  }

  /**
   * Recalculate all Sybil scores (Admin only)
   */
  @Post('recalculate-all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recalculate all Sybil scores (admin only)' })
  async recalculateAll() {
    return this.sybilResistanceService.recalculateAllScores();
  }
}
