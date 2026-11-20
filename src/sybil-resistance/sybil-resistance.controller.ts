import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
  UseGuards,
  ForbiddenException,
  Logger,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  RecomputeScoreOptions,
  SybilAppealRequestDto,
} from './sybil-resistance.types';

/**
 * SybilResistanceController
 *
 * Authorization matrix for every route (matches authorization-matrix.ts):
 *
 * ┌─────────────────────────────────────────────────────┬───────────────────────────────┐
 * │ Route                                               │ Authorization                 │
 * ├─────────────────────────────────────────────────────┼───────────────────────────────┤
 * │ GET  /sybil/users/:userId/score                     │ AUTHN                         │
 * │ GET  /sybil/users/:userId/public-score              │ PUBLIC                        │
 * │ GET  /sybil/users/:userId/appeals                   │ AUTHN + OWNERSHIP             │
 * │ GET  /sybil/users/:userId/history                   │ PUBLIC                        │
 * │ GET  /sybil/users/:userId/voting                    │ PUBLIC                        │
 * │ GET  /sybil/models                                  │ PUBLIC                        │
 * ├─────────────────────────────────────────────────────┼───────────────────────────────┤
 * │ POST /sybil/users/:userId/score                     │ ADMIN                         │
 * │ POST /sybil/users/:userId/recompute                 │ ADMIN                         │
 * │ POST /sybil/users/:userId/appeal                    │ AUTHN + OWNERSHIP             │
 * │ POST /sybil/users/:userId/verify-worldcoin          │ REMOVED — 410 Gone            │
 * │ POST /sybil/recalculate-all                         │ ADMIN                         │
 * └─────────────────────────────────────────────────────┴───────────────────────────────┘
 *
 * Design decisions:
 *
 * SCORE RECORDING / RECOMPUTATION — ADMIN only.
 *   Any authenticated user could previously record scores for arbitrary user IDs.
 *   Score writes are privileged: restricted to administrators so they cannot be
 *   used to manipulate another user's risk signal.
 *
 * APPEALS — self-service with ownership enforcement.
 *   Appeals are derived from the authenticated principal; the route :userId is
 *   validated against the JWT subject by SybilOwnershipGuard. Users cannot
 *   submit appeals on behalf of others.
 *
 * WORLDCOIN VERIFY-WORLDCOIN — removed.
 *   This endpoint accepted a caller-supplied boolean that mutated Worldcoin
 *   verification state directly (bypassing proof verification).  The only
 *   legitimate path to Worldcoin status is proof submission through
 *   POST /identity/worldcoin/verify (JwtAuthGuard + WorldcoinVerificationGuard).
 *   The endpoint is removed and callers receive 410 Gone; the service method
 *   setWorldcoinVerified is retained for internal/admin use only but is no
 *   longer callable from the public API.
 *
 * BULK RECALCULATION — ADMIN only.
 *   Recalculating all scores touches every user record and is a privileged
 *   operation. It is guarded by AdminGuard + @AdminOnly() and audit-logged
 *   inside the service.
 *
 * ADVISORY NATURE OF SCORES.
 *   Sybil scores are off-chain advisory signals. No endpoint in this controller
 *   can directly mutate claims, votes, rewards, or settlement state. The
 *   SybilProvenanceService.assertNoContractMutation() invariant is enforced
 *   at the service layer.
 */
@ApiTags('sybil')
@Controller('sybil')
export class SybilResistanceController {
  private readonly logger = new Logger(SybilResistanceController.name);

  constructor(
    private readonly sybilResistanceService: SybilResistanceService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // READ ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GET /sybil/users/:userId/score
   *
   * Retrieve the most recent Sybil score for any user.
   * Requires authentication so the caller is identifiable; score records
   * include detailed provenance that should not be unauthenticated.
   */
  @Get('users/:userId/score')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get latest Sybil score (authenticated)' })
  @ApiResponse({ status: 200, description: 'Latest score' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async getLatestScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getLatestSybilScore(userId);
  }

  /**
   * GET /sybil/users/:userId/public-score
   *
   * Privacy-safe public view of a Sybil score (no nullifier hash, no proof,
   * no linked wallet addresses).  Publicly accessible.
   */
  @Get('users/:userId/public-score')
  @ApiOperation({
    summary: 'Get privacy-safe public Sybil score view (public)',
  })
  @ApiResponse({ status: 200, description: 'Public score view' })
  async getPublicScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getPublicSybilScore(userId);
  }

  /**
   * GET /sybil/users/:userId/appeals
   *
   * Get appeal history for the authenticated user's own account.
   * SybilOwnershipGuard ensures only the account owner can read their appeals.
   */
  @Get('users/:userId/appeals')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get appeal history (own account only)' })
  @ApiResponse({ status: 200, description: 'Appeal history' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'May only view own appeals' })
  async getAppeals(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getAppeals(userId);
  }

  /**
   * GET /sybil/models
   *
   * List available Sybil score model versions. Publicly accessible.
   */
  @Get('models')
  @ApiOperation({ summary: 'List available Sybil scoring model versions' })
  @ApiResponse({ status: 200, description: 'Model versions' })
  async getModels() {
    return this.sybilResistanceService.getModelVersions();
  }

  /**
   * GET /sybil/users/:userId/history
   *
   * Score history for a user. Publicly accessible (provenance audit trail).
   */
  @Get('users/:userId/history')
  @ApiOperation({ summary: 'Get Sybil score history (public)' })
  @ApiResponse({ status: 200, description: 'Score history' })
  async getScoreHistory(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreHistory(userId);
  }

  /**
   * GET /sybil/users/:userId/voting
   *
   * Sybil score formatted for voting/verification engines. Publicly accessible.
   */
  @Get('users/:userId/voting')
  @ApiOperation({ summary: 'Get Sybil score for voting engines (public)' })
  @ApiResponse({ status: 200, description: 'Voting score' })
  async getScoreForVoting(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.getSybilScoreForVoting(userId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WRITE ENDPOINTS — PRIVILEGED (ADMIN)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /sybil/users/:userId/score
   *
   * Compute and persist a new Sybil score for a user.
   *
   * ADMIN only: score recording is a privileged operation. Any authenticated
   * user being able to trigger score writes for arbitrary user IDs would allow
   * score manipulation (inflating or deflating another user's risk signal).
   */
  @Post('users/:userId/score')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record Sybil score for a user (admin only)' })
  @ApiResponse({ status: 201, description: 'Score recorded' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  async recordScore(@Param('userId') userId: string) {
    if (!userId || userId.trim() === '') {
      throw new BadRequestException('User ID is required');
    }
    return this.sybilResistanceService.recordSybilScore(userId);
  }

  /**
   * POST /sybil/users/:userId/recompute
   *
   * Deterministic recomputation with optional pinned version and authority.
   *
   * ADMIN only: recomputation can pin specific model versions and override
   * fail-closed options, making it a privileged scoring operation.
   */
  @Post('users/:userId/recompute')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Recompute Sybil score with options (admin only)',
  })
  @ApiResponse({ status: 201, description: 'Score recomputed' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
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

  /**
   * POST /sybil/recalculate-all
   *
   * Bulk recalculation of Sybil scores for all users.
   *
   * ADMIN only: touches every user record. Audited inside the service.
   */
  @Post('recalculate-all')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recalculate all Sybil scores (admin only)' })
  @ApiResponse({ status: 201, description: 'Recalculation results' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
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
  // WRITE ENDPOINTS — SELF-SERVICE (AUTHENTICATED + OWNERSHIP)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /sybil/users/:userId/appeal
   *
   * Submit an appeal against an unfavorable Sybil score evaluation.
   *
   * Self-service, ownership-enforced: the authenticated user may only appeal
   * their own account. SybilOwnershipGuard ensures :userId matches the JWT
   * subject — user IDs in the path cannot override the authenticated principal.
   * One-active-appeal enforcement is applied in the service layer.
   */
  @Post('users/:userId/appeal')
  @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a Sybil score appeal (own account only)' })
  @ApiResponse({ status: 201, description: 'Appeal submitted' })
  @ApiResponse({
    status: 400,
    description: 'Invalid appeal or one already active',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
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
   * POST /sybil/users/:userId/verify-worldcoin
   *
   * REMOVED — this endpoint accepted a caller-supplied `verified: boolean`
   * that could directly set Worldcoin verification state without proof
   * verification, creating a trivial privilege-escalation path.
   *
   * Worldcoin verification status is proof-derived only.  The authoritative
   * verification path is POST /identity/worldcoin/verify which requires a
   * valid ZK proof and is guarded by JwtAuthGuard + WorldcoinVerificationGuard.
   *
   * Returns 410 Gone so callers know the endpoint is permanently removed.
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
      'Endpoint permanently removed. Use POST /identity/worldcoin/verify with a ZK proof.',
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
