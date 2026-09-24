import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GovernanceCache {
  private readonly logger = new Logger(GovernanceCache.name);
  private readonly ttl: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.ttl = this.configService.get<number>('CACHE_GOVERNANCE_TTL', 3600);
  }

  private getProposalKey(id: string): string {
    return `governance:proposal:${id}`;
  }

  private getActiveProposalsKey(): string {
    return 'governance:proposals:active';
  }

  private getAllProposalsKey(): string {
    return 'governance:proposals:all';
  }

  private getStatsKey(): string {
    return 'governance:stats';
  }

  private getVotesKey(proposalId: string): string {
    return `governance:votes:${proposalId}`;
  }

  async getProposal(id: string): Promise<any | null> {
    const data = await this.redisService.get(this.getProposalKey(id));
    if (data) {
      this.logger.debug(`Cache hit for governance proposal:${id}`);
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    this.logger.debug(`Cache miss for governance proposal:${id}`);
    return null;
  }

  async setProposal(id: string, proposal: any): Promise<void> {
    await this.redisService.set(
      this.getProposalKey(id),
      JSON.stringify(proposal),
      this.ttl,
    );
  }

  async getActiveProposals(): Promise<any[] | null> {
    const data = await this.redisService.get(this.getActiveProposalsKey());
    if (data) {
      this.logger.debug('Cache hit for governance:proposals:active');
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setActiveProposals(proposals: any[]): Promise<void> {
    await this.redisService.set(
      this.getActiveProposalsKey(),
      JSON.stringify(proposals),
      this.ttl,
    );
  }

  async getStats(): Promise<any | null> {
    const data = await this.redisService.get(this.getStatsKey());
    if (data) {
      this.logger.debug('Cache hit for governance:stats');
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

  async getVotes(proposalId: string): Promise<any[] | null> {
    const data = await this.redisService.get(this.getVotesKey(proposalId));
    if (data) {
      this.logger.debug(`Cache hit for governance:votes:${proposalId}`);
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setVotes(proposalId: string, votes: any[]): Promise<void> {
    await this.redisService.set(
      this.getVotesKey(proposalId),
      JSON.stringify(votes),
      this.ttl,
    );
  }

  async invalidateProposal(id: string): Promise<void> {
    const promises = [
      this.redisService.del(this.getProposalKey(id)),
      this.redisService.del(this.getActiveProposalsKey()),
      this.redisService.del(this.getAllProposalsKey()),
      this.redisService.del(this.getStatsKey()),
      this.redisService.del(this.getVotesKey(id)),
    ];
    await Promise.all(promises);
    this.logger.debug(`Invalidated cache for governance proposal:${id}`);
  }

  async invalidateAll(): Promise<void> {
    const promises = [
      this.redisService.del(this.getActiveProposalsKey()),
      this.redisService.del(this.getAllProposalsKey()),
      this.redisService.del(this.getStatsKey()),
    ];
    await Promise.all(promises);
    this.logger.debug('Invalidated all governance caches');
  }
}
