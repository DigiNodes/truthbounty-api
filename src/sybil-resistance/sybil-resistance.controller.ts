import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SybilResistanceService } from './sybil-resistance.service';
import {
  RecomputeScoreOptions,
  SybilAppealRequestDto,
} from './sybil-resistance.types';

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
