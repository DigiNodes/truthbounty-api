import { LeaderboardRefreshJob } from './leaderboard.refresh.job';

describe('LeaderboardRefreshJob', () => {
  it('clears leaderboards and calls bulkUpdateScores with users from prisma', async () => {
    const mockLeaderboardService: any = {
      clearLeaderboard: jest.fn().mockResolvedValue(undefined),
      bulkUpdateScores: jest.fn().mockResolvedValue(undefined),
    };

    const mockPrisma: any = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'u1', reputation: 10 },
          { id: 'u2', reputation: 20 },
        ]),
      },
    };

    const job = new LeaderboardRefreshJob(mockLeaderboardService, mockPrisma);

    // call refresh
    await job.refreshLeaderboard();

    expect(mockLeaderboardService.clearLeaderboard).toHaveBeenCalledWith('global');
    expect(mockLeaderboardService.clearLeaderboard).toHaveBeenCalledWith('weekly');
    expect(mockLeaderboardService.bulkUpdateScores).toHaveBeenCalledWith(
      [
        { id: 'u1', reputation: 10 },
        { id: 'u2', reputation: 20 },
      ],
    );
  });
});
