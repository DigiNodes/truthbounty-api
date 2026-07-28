import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { ConfigurationValue } from './entities/configuration-value.entity';
import { ConfigurationHistoryEntry } from './feature-flags.types';

const CACHE_TTL_SECONDS = 60;

@Injectable()
export class ConfigurationService {
  private readonly logger = new Logger(ConfigurationService.name);

  constructor(
    @InjectRepository(ConfigurationValue)
    private readonly configRepo: Repository<ConfigurationValue>,
    private readonly redisService: RedisService,
  ) {}

  async get<T = unknown>(key: string, environment?: string): Promise<T | null> {
    const env = environment ?? this.getDefaultEnvironment();
    const cached = await this.redisService.get(this.cacheKey(key, env));
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // fall through to DB
      }
    }

    const record = await this.configRepo.findOne({ where: { key, environment: env } });
    if (!record) return null;

    await this.redisService.set(
      this.cacheKey(key, env),
      JSON.stringify(record.value),
      CACHE_TTL_SECONDS,
    );
    return record.value as T;
  }

  async getRequired<T = unknown>(
    key: string,
    environment?: string,
  ): Promise<T> {
    const value = await this.get<T>(key, environment);
    if (value === null) {
      throw new NotFoundException(`Configuration ${key} not found`);
    }
    return value;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    environment?: string,
    createdBy?: string,
    changeReason?: string,
  ): Promise<ConfigurationValue> {
    const env = environment ?? this.getDefaultEnvironment();
    const existing = await this.configRepo.findOne({
      where: { key, environment: env },
    });

    if (existing) {
      const nextVersion = existing.version + 1;
      await this.configRepo.update(existing.id, {
        value: value as unknown,
        version: nextVersion,
        createdBy,
        changeReason,
      });
      await this.invalidateCache(key, env);
      return this.configRepo.findOneOrFail({ where: { id: existing.id } });
    }

    const record = this.configRepo.create({
      key,
      value: value as unknown,
      environment: env,
      version: 1,
      createdBy,
      changeReason,
    });
    const saved = await this.configRepo.save(record);
    await this.invalidateCache(key, env);
    return saved;
  }

  async findAll(environment?: string): Promise<ConfigurationValue[]> {
    const env = environment ?? this.getDefaultEnvironment();
    return this.configRepo.find({
      where: { environment: env },
      order: { key: 'ASC' },
    });
  }

  async findOne(id: string): Promise<ConfigurationValue> {
    const record = await this.configRepo.findOne({ where: { id } });
    if (!record) throw new NotFoundException(`Configuration ${id} not found`);
    return record;
  }

  async delete(id: string): Promise<void> {
    const record = await this.findOne(id);
    await this.configRepo.delete(id);
    await this.invalidateCache(record.key, record.environment);
  }

  async getHistory(
    key: string,
    environment?: string,
    limit = 50,
  ): Promise<ConfigurationHistoryEntry[]> {
    const env = environment ?? this.getDefaultEnvironment();
    const records = await this.configRepo.find({
      where: { key, environment: env },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return records.map((r) => ({
      id: r.id,
      key: r.key,
      value: r.value,
      version: r.version,
      createdBy: r.createdBy,
      changeReason: r.changeReason,
      createdAt: r.createdAt,
    }));
  }

  private async invalidateCache(key: string, environment: string): Promise<void> {
    await this.redisService.del(this.cacheKey(key, environment));
  }

  private cacheKey(key: string, environment: string): string {
    return `config:${environment}:${key}`;
  }

  private getDefaultEnvironment(): string {
    return process.env.NODE_ENV ?? 'development';
  }
}
