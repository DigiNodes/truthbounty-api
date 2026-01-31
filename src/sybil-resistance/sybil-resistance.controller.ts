import { Controller, Get, Post, Param, Body, BadRequestException } from '@nestjs/common';
import { SybilResistanceService } from './sybil-resistance.service';

@Controller('sybil')
export class SybilResistanceController {
  constructor(private readonly sybilResistanceService: SybilResistanceService) {}

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
    return this.sybilResistanceService.setWorldcoinVerified(userId, body.verified);
  }

  /**
   * Recalculate all Sybil scores (admin operation)
   */
  @Post('recalculate-all')
  async recalculateAll() {
    return this.sybilResistanceService.recalculateAllScores();
  }
}
