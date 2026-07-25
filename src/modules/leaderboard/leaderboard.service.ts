import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { LEADERBOARD_KEYS } from './leaderboard.constants';

@Injectable()
export class LeaderboardService {
    constructor(
        @Inject('REDIS_CLIENT')
        private readonly redis: Redis,
    ) { }

    // 🔹 Add / update user score
    async updateScore(
        userId: string,
        score: number,
    ): Promise<void> {
        // Use a pipeline to reduce round trips for two ZADD operations
        const pipeline = this.redis.pipeline();
        pipeline.zadd(LEADERBOARD_KEYS.GLOBAL, score, userId);
        pipeline.zadd(LEADERBOARD_KEYS.WEEKLY, score, userId);
        await pipeline.exec();
    }

    // Bulk update scores using pipelining in chunks to avoid many roundtrips
    async bulkUpdateScores(
        users: { id: string; reputation: number }[],
        chunkSize = 500,
    ): Promise<void> {
        for (let i = 0; i < users.length; i += chunkSize) {
            const chunk = users.slice(i, i + chunkSize);
            const pipeline = this.redis.pipeline();
            for (const u of chunk) {
                pipeline.zadd(LEADERBOARD_KEYS.GLOBAL, u.reputation, u.id);
                pipeline.zadd(LEADERBOARD_KEYS.WEEKLY, u.reputation, u.id);
            }
            await pipeline.exec();
        }
    }

    // 🔹 Get leaderboard
    async getLeaderboard(
        type: 'global' | 'weekly',
        limit = 10,
    ) {
        const key =
            type === 'global'
                ? LEADERBOARD_KEYS.GLOBAL
                : LEADERBOARD_KEYS.WEEKLY;

        const data = await this.redis.zrevrange(
            key,
            0,
            limit - 1,
            'WITHSCORES',
        );

        const formatted: {
            userId: string;
            score: number;
            rank: number;
        }[] = [];

        for (let i = 0; i < data.length; i += 2) {
            formatted.push({
                userId: data[i],
                score: Number(data[i + 1]),
                rank: i / 2 + 1,
            });
        }

        return formatted;
    }

    // 🔹 Clear leaderboard (used by refresh job)
    async clearLeaderboard(type: 'global' | 'weekly') {
        const key =
            type === 'global'
                ? LEADERBOARD_KEYS.GLOBAL
                : LEADERBOARD_KEYS.WEEKLY;

        await this.redis.del(key);
    }
}