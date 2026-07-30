import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReputationCache {
  private readonly logger = new Logger(ReputationCache.name);
  private readonly ttl: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.ttl = this.configService.get<number>('CACHE_REPUTATION_TTL', 3600);
  }

  private getUserKey(wallet: string): string {
    return `reputation:user:${wallet.toLowerCase()}`;
  }

  private getLeaderboardKey(type: string): string {
    return `reputation:leaderboard:${type}`;
  }

  private getEventsKey(wallet: string): string {
    return `reputation:events:${wallet.toLowerCase()}`;
  }

  private getStatsKey(): string {
    return 'reputation:stats';
  }

  async getUserReputation(wallet: string): Promise<any | null> {
    const data = await this.redisService.get(this.getUserKey(wallet));
    if (data) {
      this.logger.debug(`Cache hit for reputation:user:${wallet}`);
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setUserReputation(wallet: string, reputation: any): Promise<void> {
    await this.redisService.set(
      this.getUserKey(wallet),
      JSON.stringify(reputation),
      this.ttl,
    );
  }

  async getLeaderboard(type: string): Promise<any[] | null> {
    const data = await this.redisService.get(this.getLeaderboardKey(type));
    if (data) {
      this.logger.debug(`Cache hit for reputation:leaderboard:${type}`);
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setLeaderboard(type: string, leaderboard: any[]): Promise<void> {
    await this.redisService.set(
      this.getLeaderboardKey(type),
      JSON.stringify(leaderboard),
      this.ttl,
    );
  }

  async getEvents(wallet: string): Promise<any[] | null> {
    const data = await this.redisService.get(this.getEventsKey(wallet));
    if (data) {
      this.logger.debug(`Cache hit for reputation:events:${wallet}`);
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setEvents(wallet: string, events: any[]): Promise<void> {
    await this.redisService.set(
      this.getEventsKey(wallet),
      JSON.stringify(events),
      this.ttl,
    );
  }

  async getStats(): Promise<any | null> {
    const data = await this.redisService.get(this.getStatsKey());
    if (data) {
      this.logger.debug('Cache hit for reputation:stats');
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setStats(stats: any): Promise<void> {
    await this.redisService.set(
      this.getStatsKey(),
      JSON.stringify(stats),
      this.ttl,
    );
  }

  async invalidateUser(wallet: string): Promise<void> {
    const promises = [
      this.redisService.del(this.getUserKey(wallet)),
      this.redisService.del(this.getEventsKey(wallet)),
      this.redisService.del(this.getLeaderboardKey('highest')),
      this.redisService.del(this.getLeaderboardKey('fastest_growing')),
      this.redisService.del(this.getLeaderboardKey('most_active')),
      this.redisService.del(this.getStatsKey()),
    ];
    await Promise.all(promises);
    this.logger.debug(`Invalidated cache for reputation:user:${wallet}`);
  }
}
