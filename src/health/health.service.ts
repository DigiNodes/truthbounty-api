import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import {
  DependencyStatus,
  HealthCheckResult,
  HealthStatus,
  LivenessResult,
  ReadinessResult,
  SystemDiagnostics,
} from './health.types';

interface CheckConfig {
  name: string;
  critical: boolean;
  check: () => Promise<void>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();
  private readonly lastSuccess = new Map<string, string>();
  private appVersion: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
    @InjectQueue('jobs-queue') private readonly jobsQueue: Queue,
  ) {
    this.appVersion = process.env.npm_package_version ?? '0.0.1';
  }

  getLiveness(): LivenessResult {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
    };
  }

  async getReadiness(): Promise<ReadinessResult> {
    const dependencies = await this.runChecks();
    const unhealthyCritical = dependencies.some(
      (d) => d.status === 'unhealthy',
    );
    const degraded = dependencies.some((d) => d.status === 'degraded');

    let status: HealthStatus = 'healthy';
    if (unhealthyCritical) status = 'unhealthy';
    else if (degraded) status = 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      ready: status !== 'unhealthy',
      dependencies,
    };
  }

  async getHealth(): Promise<HealthCheckResult> {
    const dependencies = await this.runChecks();
    const diagnostics = this.collectDiagnostics();
    const services = this.aggregateServices(dependencies);

    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
      version: this.appVersion,
      uptime: this.getUptime(),
      services,
      dependencies,
      diagnostics,
    };
  }

  private async runChecks(): Promise<DependencyStatus[]> {
    const configs: CheckConfig[] = [
      {
        name: 'database',
        critical: true,
        check: () => this.checkDatabase(),
      },
      {
        name: 'redis',
        critical: false,
        check: () => this.checkRedis(),
      },
      {
        name: 'queue',
        critical: true,
        check: () => this.checkQueue(),
      },
    ];

    return Promise.all(
      configs.map(async (config) => {
        const start = Date.now();
        try {
          await config.check();
          const now = new Date().toISOString();
          this.lastSuccess.set(config.name, now);
          return {
            name: config.name,
            status: 'healthy' as HealthStatus,
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Health check failed for ${config.name}: ${reason}`);
          return {
            name: config.name,
            status: config.critical ? 'unhealthy' : 'degraded',
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
            failureReason: reason,
          };
        }
      }),
    );
  }

  private async checkDatabase(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      throw new Error('Database connection not initialized');
    }
    await this.dataSource.query('SELECT 1');
  }

  private async checkRedis(): Promise<void> {
    const healthy = await this.redisService.isHealthy();
    if (!healthy) {
      throw new Error('Redis is not healthy');
    }
  }

  private async checkQueue(): Promise<void> {
    // A quick BullMQ liveness check: fetch job counts without heavy iteration.
    await this.jobsQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
    );
  }

  private aggregateServices(
    dependencies: DependencyStatus[],
  ): Record<string, HealthStatus> {
    return dependencies.reduce(
      (acc, dep) => {
        acc[dep.name] = dep.status;
        return acc;
      },
      {} as Record<string, HealthStatus>,
    );
  }

  private aggregateStatus(dependencies: DependencyStatus[]): HealthStatus {
    if (dependencies.some((d) => d.status === 'unhealthy')) return 'unhealthy';
    if (dependencies.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private collectDiagnostics(): SystemDiagnostics {
    return {
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
    };
  }

  private getUptime(): number {
    return Date.now() - this.startTime;
  }
}
