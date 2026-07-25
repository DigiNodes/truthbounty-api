import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LeaderboardService } from './leaderboard.service';
import { LEADERBOARD_REFRESH_CRON } from './leaderboard.constants';
import { PrismaClient } from 'src/generated/client/client';

@Injectable()
export class LeaderboardRefreshJob {
  private readonly logger = new Logger(LeaderboardRefreshJob.name);

  constructor(
    private readonly leaderboardService: LeaderboardService,
    private readonly prisma: PrismaClient,
  ) {}

  @Cron(LEADERBOARD_REFRESH_CRON)
  async refreshLeaderboard() {
    this.logger.log('Refreshing leaderboards...');

    const users = await this.fetchUsersFromDatabase();

    if (users.length === 0) {
      this.logger.warn('No users found, skipping leaderboard refresh.');
      return;
    }

    // Clear old rankings
    await this.leaderboardService.clearLeaderboard('global');
    await this.leaderboardService.clearLeaderboard('weekly');

    // Rebuild rankings from real data using batched pipelining
    await this.leaderboardService.bulkUpdateScores(users);

    this.logger.log(`Leaderboard refreshed with ${users.length} users.`);
  }

  private async fetchUsersFromDatabase(): Promise<{ id: string; reputation: number }[]> {
    return this.prisma.user.findMany({
      select: {
        id: true,
        reputation: true,
      },
      orderBy: {
        reputation: 'desc',
      },
    });
  }
}